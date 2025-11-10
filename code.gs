/**
 * Gemini File Search（DRIVE_FOLDER_IDのみ） × LINE Bot
 * - 進捗：単体バブルで段階を順番に表示
 * - 初期メニュー：画像付きの「取り込み」「要約」ボタン
 *
 * Script Properties:
 *  - GEMINI_API_KEY
 *  - DRIVE_FOLDER_ID
 *  - LINE_CHANNEL_ACCESS_TOKEN
 *  - (任意) FILE_SEARCH_STORE_NAME
 */

//////////////////// 設定 ////////////////////
const CONFIG = {
  MODEL: 'models/gemini-2.5-flash',
  STORE_DISPLAY_NAME: 'drive-import-store',
  OPERATION_POLL_MAX: 60,              // *5秒 = 最大約5分
  OPERATION_POLL_INTERVAL_MS: 5000,

  // Google系ファイルは解析しやすいフォーマットに export
  EXPORT_MIMES: {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.presentation': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
  },

  // 代表質問（「要約」で使用）
  TEST_PROMPT: 'この資料群の要点を5行以内で日本語要約してください。',

  // 画像メニュー（任意で差し替えてOK）
  THEME_COLOR: '#4a7bd3',
  IMG_IMPORT:  'https://picsum.photos/1200/675?random=11',
  IMG_SUMMARY: 'https://picsum.photos/1200/675?random=22'
};

//////////////////// プロパティ ////////////////////
function prop_(k){ return PropertiesService.getScriptProperties().getProperty(k) || ''; }
const GEMINI_API_KEY   = () => prop_('GEMINI_API_KEY').trim();
const DRIVE_FOLDER_ID  = () => prop_('DRIVE_FOLDER_ID').trim();
const LINE_TOKEN       = () => prop_('LINE_CHANNEL_ACCESS_TOKEN').trim();

//////////////////// LINE Webhook ////////////////////
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ContentService.createTextOutput('OK');
    const body = JSON.parse(e.postData.contents);
    if (!body.events || body.events.length === 0) return ContentService.createTextOutput('OK');

    const ev = body.events[0];
    const replyToken = ev.replyToken;
    const userId = ev.source && ev.source.userId ? ev.source.userId : null;

    // 友だち追加 or グループ参加時 → 初期メニューを出す
    if (ev.type === 'follow' || ev.type === 'join') {
      replyFlex_(replyToken, flexMenuCarousel());
      return ContentService.createTextOutput('OK');
    }

    if (ev.type === 'message' && ev.message?.type === 'text') {
      const text = (ev.message.text || '').trim();

      // いつでもメニュー呼び出し可能
      if (text === 'メニュー' || text === 'ヘルプ' || text.toLowerCase() === 'menu') {
        replyFlex_(replyToken, flexMenuCarousel());
        return ContentService.createTextOutput('OK');
      }

      if (text === '取り込み') {
        // 受領：進捗はボタンなし
        replyFlex_(replyToken, flexInfoBubble('取り込みを開始', 'Drive → File Search のインデックスを作成します。', 0, '準備中…', false));
        runImportAndNotify_(userId);
        return ContentService.createTextOutput('OK');
      }

      if (text === '要約') {
        replyFlex_(replyToken, flexInfoBubble('要約作成中', '取り込み済みストアから要約します。', 0, '検索中…', false));
        askAndPush_(userId, CONFIG.TEST_PROMPT);
        return ContentService.createTextOutput('OK');
      }

      // 任意の質問
      replyFlex_(replyToken, flexInfoBubble('検索＆回答作成中', '資料群を横断検索して回答します。', 0, '検索中…', false));
      askAndPush_(userId, text);
      return ContentService.createTextOutput('OK');
    }

    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error('doPost error:', err);
    return ContentService.createTextOutput('OK');
  }
}

function doGet() { return ContentService.createTextOutput('OK'); }

//////////////////// LINE送受信ユーティリティ ////////////////////
function replyFlex_(replyToken, contents) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN() };
  const payload = { replyToken, messages: [{ type: 'flex', altText: '通知', contents }] };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function pushFlex_(toUserId, contents, altText) {
  if (!toUserId) return;
  const url = 'https://api.line.me/v2/bot/message/push';
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN() };
  const payload = { to: toUserId, messages: [{ type: 'flex', altText: altText || '通知', contents }] };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

// 進捗送信用のシンプルヘルパー（%が変わった時だけ送る）
function pushProgress_(userId, title, subtitle, pct, footnote) {
  pushFlex_(userId, flexInfoBubble(title, subtitle, pct, footnote, false), '進捗');
}

//////////////////// 取り込み（Drive→File Search） ////////////////////
function runImportAndNotify_(userId) {
  try {
    if (!GEMINI_API_KEY()) throw new Error('GEMINI_API_KEY が未設定です。');
    const folderId = DRIVE_FOLDER_ID();
    if (!folderId) { pushFlex_(userId, flexErrorBubble('DRIVE_FOLDER_ID が未設定です。'), 'エラー'); return; }

    const apiKey = GEMINI_API_KEY();
    let storeName = prop_('FILE_SEARCH_STORE_NAME').trim();
    if (!storeName) {
      const store = createFileSearchStore_(apiKey, CONFIG.STORE_DISPLAY_NAME);
      storeName = store.name;
      PropertiesService.getScriptProperties().setProperty('FILE_SEARCH_STORE_NAME', storeName);
    }

    // 準備
    pushProgress_(userId, '準備', `store: ${storeName}`, 5, 'Drive をスキャン中…');

    // スキャン
    const files = driveListFilesInFolder_(folderId);
    if (!files.length) { pushFlex_(userId, flexErrorBubble('フォルダ内にファイルが見つかりませんでした。'), 'エラー'); return; }
    pushProgress_(userId, 'スキャン', 'Drive をスキャン', 20, `検出: ${files.length} 件`);

    // 取得（%はおおまかに10%刻み）
    const blobs = [];
    let dlOk = 0, dlNg = 0, lastSent = -1;
    for (let i=0; i<files.length; i++) {
      const b = driveDownloadFileAsBlob_(files[i]);
      if (b) { blobs.push(b); dlOk++; } else { dlNg++; }
      const pct = 20 + Math.round(((i+1)/files.length) * 20);  // 20→40
      if (pct >= lastSent + 10 || i === files.length - 1) {
        pushProgress_(userId, '取得', 'エクスポート/ダウンロード', pct, `成功 ${dlOk} / 失敗 ${dlNg}`);
        lastSent = pct;
      }
      Utilities.sleep(60);
    }
    if (!blobs.length) { pushFlex_(userId, flexErrorBubble('有効な取り込み対象が0件でした。権限や対応形式をご確認ください。'), 'エラー'); return; }

    // アップロード（40→70）
    lastSent = 39;
    const ops = [];
    for (let i=0; i<blobs.length; i++) {
      const op = uploadToFileSearchStore_(apiKey, storeName, blobs[i].bytes, blobs[i].contentType);
      ops.push(op.name);
      const pct = 40 + Math.round(((i+1)/blobs.length) * 30);
      if (pct >= lastSent + 10 || i === blobs.length - 1) {
        pushProgress_(userId, 'アップロード', 'File Search に投入', pct, `${i+1}/${blobs.length} 件`);
        lastSent = pct;
      }
      Utilities.sleep(100);
    }

    // インデックス（70→95）
    lastSent = 69;
    for (let t=0; t<CONFIG.OPERATION_POLL_MAX; t++) {
      let done = 0;
      for (const name of ops) {
        const url = `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`;
        const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
        if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
          const op = JSON.parse(res.getContentText());
          if (op.done) {
            if (op.error) throw new Error('Operation error: ' + JSON.stringify(op.error));
            done++;
          }
        } else {
          throw new Error(`operations.get failed: ${res.getResponseCode()} ${res.getContentText()}`);
        }
        Utilities.sleep(40);
      }
      const pct = 70 + Math.round((done/ops.length) * 25);
      if (pct >= lastSent + 5) {
        pushProgress_(userId, 'インデックス', '解析・索引構築', Math.min(pct, 95), `完了 ${done}/${ops.length}`);
        lastSent = pct;
      }
      if (done >= ops.length) break;
      Utilities.sleep(CONFIG.OPERATION_POLL_INTERVAL_MS);
    }

    const ok = waitAllOperationsDone_(apiKey, ops);
    if (!ok) { pushFlex_(userId, flexErrorBubble('インデックス作成がタイムアウトしました。'), 'エラー'); return; }

    // 完了（ボタンあり）＋ 初期メニューも続けて出す
    pushFlex_(userId, flexSuccessBubble('取り込み完了', `store: ${storeName}`, '「要約」や質問文を送ってください。'), '完了');
    pushFlex_(userId, flexMenuCarousel(), 'メニュー');
  } catch (e) {
    console.error('runImportAndNotify_ error:', e);
    if (userId) pushFlex_(userId, flexErrorBubble('取り込み中にエラーが発生しました：' + String(e)), 'エラー');
  }
}

//////////////////// 質問（File Search 有効） ////////////////////
function askAndPush_(userId, userText) {
  try {
    if (!GEMINI_API_KEY()) throw new Error('GEMINI_API_KEY が未設定です。');

    let storeName = prop_('FILE_SEARCH_STORE_NAME').trim();
    if (!storeName) { pushFlex_(userId, flexErrorBubble('まず「取り込み」を実行してください。（ストアが未作成）'), 'エラー'); return; }

    // 検索中（ボタンなし）
    pushFlex_(userId, flexInfoBubble('検索中…', '資料群の根拠を探索しています。', 20, 'File Search 有効', false), '進捗');

    const answer = askWithFileSearch_(GEMINI_API_KEY(), storeName, userText);
    const parsed = parseAnswer_(answer);

    const preview = truncate_(parsed.text || '(回答が取得できませんでした)', 850);
    const cites = (parsed.citations || []).slice(0, 5);
    const bubble = flexAnswerBubble(userText, preview, cites); // 回答はボタンあり
    pushFlex_(userId, bubble, '回答');
  } catch (e) {
    console.error('askAndPush_ error:', e);
    if (userId) pushFlex_(userId, flexErrorBubble('回答中にエラーが発生しました：' + String(e)), 'エラー');
  }
}

//////////////////// 単体テスト（LINEなし） ////////////////////
function test_driveAccess() {
  assert_();
  const folderId = DRIVE_FOLDER_ID();
  if (!folderId) throw new Error('スクリプトプロパティ DRIVE_FOLDER_ID を設定してください。');

  const files = driveListFilesInFolder_(folderId);
  Logger.log(`✔ Drive files in folder(${folderId}): ${files.length}`);
  const sample = files.slice(0, Math.min(5, files.length));
  let ok = 0, ng = 0, bytes = 0;

  for (const f of sample) {
    const b = driveDownloadFileAsBlob_(f);
    if (b) { ok++; bytes += b.bytes.length; } else { ng++; }
    Utilities.sleep(80);
  }
  Logger.log(`✔ sample download/export OK=${ok}, NG=${ng}, bytes=${bytes}`);
  return 'OK';
}

function test_fileSearchEndToEnd() {
  assert_();
  const apiKey = GEMINI_API_KEY();
  const folderId = DRIVE_FOLDER_ID();
  if (!folderId) throw new Error('DRIVE_FOLDER_ID が未設定です。');

  const store = createFileSearchStore_(apiKey, CONFIG.STORE_DISPLAY_NAME);
  const storeName = store.name;
  Logger.log(`✔ store created: ${storeName}`);

  const files = driveListFilesInFolder_(folderId);
  if (!files.length) throw new Error('フォルダ内にファイルが見つかりません。');
  const blobs = [];
  for (const f of files) {
    const b = driveDownloadFileAsBlob_(f);
    if (b) blobs.push(b);
    Utilities.sleep(80);
  }
  if (!blobs.length) throw new Error('有効な取り込み対象（ダウンロード/エクスポート成功）が0件です。');

  const ops = [];
  for (const b of blobs) {
    const op = uploadToFileSearchStore_(apiKey, storeName, b.bytes, b.contentType);
    ops.push(op.name);
    Utilities.sleep(120);
  }
  Logger.log(`✔ upload queued: ${ops.length} ops`);

  const ok = waitAllOperationsDone_(apiKey, ops);
  if (!ok) throw new Error('インデックス作成がタイムアウトしました。');
  Logger.log('✔ indexing finished');

  const answer = askWithFileSearch_(apiKey, storeName, CONFIG.TEST_PROMPT);
  const parsed = parseAnswer_(answer);
  Logger.log('✔ answer text:\n' + (parsed.text || '(no text)'));
  if (parsed.citations?.length) Logger.log('✔ citations:\n' + parsed.citations.join('\n'));
  return 'OK';
}

function test_askAfterExistingStore() {
  assert_();
  const apiKey = GEMINI_API_KEY();
  const storeName = prop_('FILE_SEARCH_STORE_NAME').trim();
  if (!storeName) throw new Error('FILE_SEARCH_STORE_NAME が未設定です。まず取り込みを実行してください。');
  const prompt = CONFIG.TEST_PROMPT;

  const answer = askWithFileSearch_(apiKey, storeName, prompt);
  const parsed = parseAnswer_(answer);
  Logger.log('✔ answer text:\n' + (parsed.text || '(no text)'));
  if (parsed.citations?.length) Logger.log('✔ citations:\n' + parsed.citations.join('\n'));
  return 'OK';
}

//////////////////// 内部：前提チェック ////////////////////
function assert_() { if (!GEMINI_API_KEY()) throw new Error('GEMINI_API_KEY が未設定です。'); }

//////////////////// Gemini File Search API ////////////////////
function createFileSearchStore_(apiKey, displayName) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=' + encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ displayName }), muteHttpExceptions: true });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(body);
  throw new Error(`createFileSearchStore failed: ${code} ${body}`);
}

function uploadToFileSearchStore_(apiKey, storeName, bytes, contentType) {
  const base = 'https://generativelanguage.googleapis.com/upload/v1beta/';
  const path = `${storeName}:uploadToFileSearchStore`;
  const url = `${base}${path}?uploadType=media&key=${encodeURIComponent(apiKey)}`;
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: contentType || 'application/octet-stream', payload: bytes, muteHttpExceptions: true });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(body);
  throw new Error(`uploadToFileSearchStore failed: ${code} ${body}`);
}

function waitAllOperationsDone_(apiKey, operationNames) {
  const pending = new Set(operationNames);
  const base = 'https://generativelanguage.googleapis.com/v1beta/';

  for (let t = 0; t < CONFIG.OPERATION_POLL_MAX; t++) {
    const doneNow = [];
    for (const name of pending) {
      const url = `${base}${name}?key=${encodeURIComponent(apiKey)}`;
      const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
      if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
        const op = JSON.parse(res.getContentText());
        if (op.done) {
          if (op.error) throw new Error('Operation error: ' + JSON.stringify(op.error));
          doneNow.push(name);
        }
      } else {
        throw new Error(`operations.get failed: ${res.getResponseCode()} ${res.getContentText()}`);
      }
      Utilities.sleep(80);
    }
    doneNow.forEach(n => pending.delete(n));
    if (pending.size === 0) return true;
    Utilities.sleep(CONFIG.OPERATION_POLL_INTERVAL_MS);
  }
  return false;
}

function askWithFileSearch_(apiKey, storeName, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${CONFIG.MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = { contents: [{ role: 'user', parts: [{ text: userText }]}], tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }] };
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(body);
  throw new Error(`generateContent failed: ${code} ${body}`);
}

//////////////////// Drive ユーティリティ ////////////////////
function driveListFilesInFolder_(folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const fields = 'files(id,name,mimeType,modifiedTime)';
  const token = ScriptApp.getOAuthToken();
  let pageToken = '', out = [];
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${pageToken ? '&pageToken='+pageToken : ''}`;
    const res = UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Drive files.list 失敗: ' + res.getContentText());
    const data = JSON.parse(res.getContentText());
    if (data.files?.length) out.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

function driveDownloadFileAsBlob_(fileMeta) {
  const token = ScriptApp.getOAuthToken();
  const id = fileMeta.id;
  const name = fileMeta.name || 'download';
  const mime = fileMeta.mimeType;

  if (CONFIG.EXPORT_MIMES[mime]) {
    const exportMime = CONFIG.EXPORT_MIMES[mime];
    const url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { Logger.log('Export failed:', name, res.getContentText()); return null; }
    const bytes = res.getContent();
    const ext = exportMime === 'application/pdf' ? '.pdf' : exportMime === 'text/csv' ? '.csv' : '';
    return { name: name + ext, contentType: exportMime, bytes };
  }

  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const res = UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { Logger.log('Download failed:', name, res.getContentText()); return null; }
  const contentType = res.getHeaders()['Content-Type'] || 'application/octet-stream';
  return { name, contentType, bytes: res.getContent() };
}

//////////////////// 応答整形 ////////////////////
function parseAnswer_(apiJson) {
  const candidates = apiJson?.candidates || [];
  const first = candidates[0];
  const textParts = first?.content?.parts?.map(p => p.text).filter(Boolean) || [];
  const text = textParts.join('\n');

  const citations = [];
  const grounding = first?.groundingMetadata;
  if (grounding?.supportingContent) {
    grounding.supportingContent.forEach(sc => {
      if (sc?.metadata?.sourceUri) citations.push(sc.metadata.sourceUri);
      if (sc?.metadata?.fileName) citations.push(sc.metadata.fileName);
    });
  }
  return { text, citations: Array.from(new Set(citations)).slice(0, 10) };
}

//////////////////// Flex ビルダー ////////////////////
// 1) 単体バブル（進捗/情報）※ showActions=false で進捗中はボタン非表示
function flexInfoBubble(title, subtitle, percent, footnote, showActions = true) {
  const body = {
    type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'lg' },
      { type: 'text', text: subtitle || '', wrap: true, color: '#666666' },
      progressBar_(percent),
      footnote ? { type: 'text', text: footnote, size: 'sm', color: '#999999', wrap: true } : { type: 'box', layout: 'baseline', contents: [] }
    ]
  };
  const bubble = { type: 'bubble', size: 'mega', body };
  if (showActions) {
    bubble.footer = { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [ quickButton_('取り込み'), quickButton_('要約') ] };
  }
  return bubble;
}

// 2) 成功/エラー
function flexSuccessBubble(title, subtitle, footnote) {
  return {
    type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: '✅ ' + title, weight: 'bold', size: 'lg', color: '#0A7D32' },
      { type: 'text', text: subtitle || '', wrap: true },
      { type: 'text', text: footnote || '', wrap: true, color: '#666666' }
    ]},
    footer: { type: 'box', layout: 'horizontal', contents: [ quickButton_('要約') ] }
  };
}
function flexErrorBubble(message) {
  return {
    type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: '⚠ エラー', weight: 'bold', size: 'lg', color: '#B00020' },
      { type: 'text', text: message, wrap: true, color: '#666666' }
    ]},
    footer: { type: 'box', layout: 'horizontal', contents: [ quickButton_('取り込み') ] }
  };
}

// 3) 回答（要約＋根拠リンク）※ボタンあり
function flexAnswerBubble(question, answerPreview, citations) {
  const citeItems = (citations || []).map((u, i) => ({ type: 'text', text: `［${i+1}］ ${u}`, size: 'sm', color: CONFIG.THEME_COLOR, wrap: true }));
  return {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '回答', weight: 'bold', size: 'lg' },
      { type: 'text', text: 'Q: ' + truncate_(question, 120), size: 'sm', color: '#666666', wrap: true }
    ]},
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: answerPreview, wrap: true },
      (citeItems.length > 0)
        ? { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: '— 根拠 —', weight: 'bold', size: 'sm' }, ...citeItems] }
        : { type: 'box', layout: 'vertical', contents: [] }
    ]},
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [ quickButton_('取り込み'), quickButton_('要約') ] }
  };
}

// 4) 画像付きメニュー（横スクロール）：「取り込み」「要約」
function flexMenuCarousel() {
  const b1 = heroMenuBubble('Driveを取り込む', 'フォルダをインデックス化して質問に備えます。', CONFIG.IMG_IMPORT, '取り込み');
  const b2 = heroMenuBubble('要約を作る', '取り込み済みの資料群から要約を作成します。', CONFIG.IMG_SUMMARY, '要約');
  return { type: 'carousel', contents: [b1, b2] };
}
function heroMenuBubble(title, desc, imageUrl, actionText) {
  return {
    type: 'bubble',
    hero: { type: 'image', url: imageUrl, size: 'full', aspectRatio: '16:9', aspectMode: 'cover' },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'lg' },
      { type: 'text', text: desc, wrap: true, color: '#666666' }
    ]},
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: CONFIG.THEME_COLOR, action: { type: 'message', label: title, text: actionText } },
      { type: 'button', style: 'link', action: { type: 'message', label: 'メニュー', text: 'メニュー' } }
    ]}
  };
}

// 共通パーツ
function progressBar_(percent) {
  const pct = clamp_(Math.round(percent || 0), 0, 100);
  return {
    type: 'box', layout: 'vertical', contents: [
      { type: 'box', layout: 'vertical', contents: [{ type: 'filler' }], height: '8px', backgroundColor: '#e0e0e0', cornerRadius: 'sm' },
      { type: 'box', layout: 'vertical', contents: [{ type: 'filler' }], height: '8px', backgroundColor: CONFIG.THEME_COLOR, cornerRadius: 'sm', position: 'absolute', width: pct + '%' }
    ], position: 'relative', margin: 'md'
  };
}
function quickButton_(label) { return { type: 'button', style: 'link', action: { type: 'message', label, text: label } }; }
function clamp_(v, min, max) { return Math.max(min, Math.min(max, v)); }
function truncate_(s, n) { if (!s) return s; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
