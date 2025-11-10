/**
 * Gemini File Search（DRIVE_FOLDER_IDのみ） × LINE Bot（進捗表示＆Flex UI）
 * Script Properties:
 *  - GEMINI_API_KEY
 *  - DRIVE_FOLDER_ID                  …単一のDriveフォルダID
 *  - LINE_CHANNEL_ACCESS_TOKEN        …Messaging APIの長期トークン
 *  - (任意) FILE_SEARCH_STORE_NAME    …既存ストア名（再利用したい場合）
 *
 * Botコマンド:
 *  - 「取り込み」… Driveフォルダ配下をインデックス化（進捗をFlexで逐次push）
 *  - 「要約」    … 代表質問（CONFIG.TEST_PROMPT）を実行してFlexで結果表示
 *  - 任意のテキスト … そのままFile Search有効で質問してFlexで結果表示
 *
 * 単体テスト関数（LINEなしで検証できる）:
 *  - test_driveAccess()
 *  - test_fileSearchEndToEnd()
 *  - test_askAfterExistingStore()
 */

//////////////////// 設定 ////////////////////
const CONFIG = {
  MODEL: 'models/gemini-2.5-flash',
  STORE_DISPLAY_NAME: 'drive-import-store',
  OPERATION_POLL_MAX: 60,          // *5秒 = 最大約5分
  OPERATION_POLL_INTERVAL_MS: 5000,

  // Google系ファイルは解析しやすいフォーマットに export して取り込み
  EXPORT_MIMES: {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.presentation': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
  },

  // 代表質問（LINEの「要約」で使用）
  TEST_PROMPT: 'この資料群の要点を5行以内で日本語要約してください。',

  // 進捗の通知頻度
  UPLOAD_PROGRESS_EVERY: 5, // n件ごとに進捗push
  POLL_PROGRESS_EVERY: 2    // n回ポーリングごとに進捗push
};

//////////////////// プロパティ ////////////////////
function prop_(k){ return PropertiesService.getScriptProperties().getProperty(k) || ''; }
const GEMINI_API_KEY = () => prop_('GEMINI_API_KEY').trim();
const DRIVE_FOLDER_ID = () => prop_('DRIVE_FOLDER_ID').trim();
const LINE_TOKEN = () => prop_('LINE_CHANNEL_ACCESS_TOKEN').trim();

//////////////////// LINE Webhook ////////////////////
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ContentService.createTextOutput('OK');
    const body = JSON.parse(e.postData.contents);
    if (!body.events || body.events.length === 0) return ContentService.createTextOutput('OK');

    const ev = body.events[0];
    const replyToken = ev.replyToken;
    const userId = ev.source && ev.source.userId ? ev.source.userId : null;

    if (ev.type === 'message' && ev.message?.type === 'text') {
      const text = (ev.message.text || '').trim();

      if (text === '取り込み') {
        // 即時返信（受領）
        replyFlex_(replyToken, flexInfoBubble('取り込みを開始', 'Drive → File Search のインデックスを作成します。', 0, '準備中…'));
        runImportAndNotify_(userId);
        return ContentService.createTextOutput('OK');
      }

      if (text === '要約') {
        replyFlex_(replyToken, flexInfoBubble('要約作成中', '取り込み済みストアから要約します。', 0, '検索中…'));
        askAndPush_(userId, CONFIG.TEST_PROMPT);
        return ContentService.createTextOutput('OK');
      }

      // 任意の質問として処理
      replyFlex_(replyToken, flexInfoBubble('検索＆回答作成中', '資料群を横断検索して回答します。', 0, '検索中…'));
      askAndPush_(userId, text);
      return ContentService.createTextOutput('OK');
    }

    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error('doPost error:', err);
    return ContentService.createTextOutput('OK');
  }
}

function doGet() {
  return ContentService.createTextOutput('OK');
}

//////////////////// LINE送受信ユーティリティ ////////////////////
function replyText_(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + LINE_TOKEN()
  };
  const payload = { replyToken, messages: [{ type: 'text', text }] };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function replyFlex_(replyToken, bubble) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + LINE_TOKEN()
  };
  const payload = {
    replyToken,
    messages: [{
      type: 'flex',
      altText: '処理中',
      contents: bubble
    }]
  };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function pushText_(toUserId, text) {
  if (!toUserId) return;
  const url = 'https://api.line.me/v2/bot/message/push';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + LINE_TOKEN()
  };
  const payload = { to: toUserId, messages: [{ type: 'text', text }] };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function pushFlex_(toUserId, bubble, altText) {
  if (!toUserId) return;
  const url = 'https://api.line.me/v2/bot/message/push';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + LINE_TOKEN()
  };
  const payload = {
    to: toUserId,
    messages: [{
      type: 'flex',
      altText: altText || '通知',
      contents: bubble
    }]
  };
  UrlFetchApp.fetch(url, { method: 'post', headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
}

//////////////////// 取り込み（Drive→File Search） ////////////////////
function runImportAndNotify_(userId) {
  try {
    if (!GEMINI_API_KEY()) throw new Error('GEMINI_API_KEY が未設定です。');
    const folderId = DRIVE_FOLDER_ID();
    if (!folderId) { pushFlex_(userId, flexErrorBubble('DRIVE_FOLDER_ID が未設定です。'), 'エラー'); return; }

    // 1) ストア作成 or 再利用
    const apiKey = GEMINI_API_KEY();
    let storeName = prop_('FILE_SEARCH_STORE_NAME').trim();
    if (!storeName) {
      const store = createFileSearchStore_(apiKey, CONFIG.STORE_DISPLAY_NAME);
      storeName = store.name;
      PropertiesService.getScriptProperties().setProperty('FILE_SEARCH_STORE_NAME', storeName);
    }
    pushFlex_(userId, flexInfoBubble('準備完了', `ストア: ${storeName}`, 5, 'Drive をスキャン中…'), '進捗');

    // 2) 取り込み対象収集（フォルダ直下）
    const files = driveListFilesInFolder_(folderId);
    if (!files.length) { pushFlex_(userId, flexErrorBubble('フォルダ内にファイルが見つかりませんでした。'), 'エラー'); return; }
    pushFlex_(userId, flexInfoBubble('スキャン完了', `検出ファイル: ${files.length} 件`, 15, 'エクスポート/ダウンロード中…'), '進捗');

    const blobs = [];
    let dlOk = 0, dlNg = 0;
    for (let i=0; i<files.length; i++) {
      const f = files[i];
      const b = driveDownloadFileAsBlob_(f);
      if (b) { blobs.push(b); dlOk++; }
      else { dlNg++; }
      if ((i+1) % CONFIG.UPLOAD_PROGRESS_EVERY === 0 || i === files.length - 1) {
        const p = Math.min(20 + Math.round((i+1)/files.length * 20), 40); // 20%→40%
        pushFlex_(userId, flexInfoBubble('取得中…', `ダウンロード/エクスポート ${i+1}/${files.length} 件`, p, `成功 ${dlOk} / 失敗 ${dlNg}`), '進捗');
      }
      Utilities.sleep(60);
    }
    if (!blobs.length) { pushFlex_(userId, flexErrorBubble('有効な取り込み対象が0件でした。権限や対応形式をご確認ください。'), 'エラー'); return; }

    // 3) アップロード
    const ops = [];
    for (let i=0; i<blobs.length; i++) {
      const b = blobs[i];
      const op = uploadToFileSearchStore_(apiKey, storeName, b.bytes, b.contentType);
      ops.push(op.name);
      if ((i+1) % CONFIG.UPLOAD_PROGRESS_EVERY === 0 || i === blobs.length - 1) {
        const p = Math.min(40 + Math.round((i+1)/blobs.length * 30), 70); // 40%→70%
        pushFlex_(userId, flexInfoBubble('アップロード中…', `${i+1}/${blobs.length} 件`, p, 'File Search に投入'), '進捗');
      }
      Utilities.sleep(100);
    }

    // 4) 完了待ち（ポーリング）
    let lastPct = 70;
    for (let t=0; t<CONFIG.OPERATION_POLL_MAX; t++) {
      const doneNow = [];
      for (const name of ops) {
        const url = `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`;
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
        Utilities.sleep(50);
      }
      const doneCount = doneNow.length;
      const pct = Math.min(70 + Math.round(doneCount/ops.length * 25), 95); // 70%→95%
      if (t % CONFIG.POLL_PROGRESS_EVERY === 0 || pct !== lastPct) {
        pushFlex_(userId, flexInfoBubble('インデックス作成中…', `完了 ${doneCount}/${ops.length} 件`, pct, '解析・索引の構築'), '進捗');
        lastPct = pct;
      }
      if (doneCount >= ops.length) break;
      Utilities.sleep(CONFIG.OPERATION_POLL_INTERVAL_MS);
    }

    // 最終チェック
    const ok = waitAllOperationsDone_(apiKey, ops);
    if (!ok) { pushFlex_(userId, flexErrorBubble('インデックス作成がタイムアウトしました。時間をおいて再試行してください。'), 'エラー'); return; }

    // 5) 完了通知
    pushFlex_(userId, flexSuccessBubble('取り込み完了', `store: ${storeName}`, '「要約」や質問文を送ってください。'), '完了');
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

    pushFlex_(userId, flexInfoBubble('検索中…', '資料群の根拠を探索しています。', 15, 'File Search 有効'), '進捗');

    const answer = askWithFileSearch_(GEMINI_API_KEY(), storeName, userText);
    const parsed = parseAnswer_(answer);

    const preview = truncate_(parsed.text || '(回答が取得できませんでした)', 850);
    const cites = (parsed.citations || []).slice(0, 5);
    const bubble = flexAnswerBubble(userText, preview, cites);

    pushFlex_(userId, bubble, '回答');
  } catch (e) {
    console.error('askAndPush_ error:', e);
    if (userId) pushFlex_(userId, flexErrorBubble('回答中にエラーが発生しました：' + String(e)), 'エラー');
  }
}

//////////////////// 単体テスト（LINEなし） ////////////////////

/** 1) Driveアクセスの単体テスト（一覧＆最初の数件をexport/ダウンロード） */
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
    if (b) { ok++; bytes += b.bytes.length; }
    else { ng++; }
    Utilities.sleep(100);
  }
  Logger.log(`✔ sample download/export OK=${ok}, NG=${ng}, bytes=${bytes}`);
  return 'OK';
}

/** 2) File Search 通しテスト（ストア作成→取り込み→待ち→質問） */
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
    Utilities.sleep(100);
  }
  if (!blobs.length) throw new Error('有効な取り込み対象（ダウンロード/エクスポート成功）が0件です。');

  const ops = [];
  for (const b of blobs) {
    const op = uploadToFileSearchStore_(apiKey, storeName, b.bytes, b.contentType);
    ops.push(op.name);
    Utilities.sleep(150);
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

/** 3) 既存ストアに対して質問だけ（取り込み済み・store名をプロパティから） */
function test_askAfterExistingStore() {
  assert_();
  const apiKey = GEMINI_API_KEY();
  const storeName = prop_('FILE_SEARCH_STORE_NAME').trim();
  if (!storeName) throw new Error('FILE_SEARCH_STORE_NAME が未設定です。まず test_fileSearchEndToEnd() か 取り込み を実行してください。');
  const prompt = CONFIG.TEST_PROMPT;

  const answer = askWithFileSearch_(apiKey, storeName, prompt);
  const parsed = parseAnswer_(answer);
  Logger.log('✔ answer text:\n' + (parsed.text || '(no text)'));
  if (parsed.citations?.length) Logger.log('✔ citations:\n' + parsed.citations.join('\n'));
  return 'OK';
}

//////////////////// 内部：前提チェック ////////////////////
function assert_() {
  if (!GEMINI_API_KEY()) throw new Error('GEMINI_API_KEY が未設定です。');
}

//////////////////// Gemini File Search API ////////////////////
function createFileSearchStore_(apiKey, displayName) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=' + encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ displayName }), muteHttpExceptions: true,
  });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(body);
  throw new Error(`createFileSearchStore failed: ${code} ${body}`);
}

function uploadToFileSearchStore_(apiKey, storeName, bytes, contentType) {
  const base = 'https://generativelanguage.googleapis.com/upload/v1beta/';
  const path = `${storeName}:uploadToFileSearchStore`; // "/" はエンコードしない
  const url = `${base}${path}?uploadType=media&key=${encodeURIComponent(apiKey)}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: contentType || 'application/octet-stream',
    payload: bytes, muteHttpExceptions: true,
  });
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
      Utilities.sleep(100);
    }
    doneNow.forEach(n => pending.delete(n));
    if (pending.size === 0) return true;
    Utilities.sleep(CONFIG.OPERATION_POLL_INTERVAL_MS);
  }
  return false; // timeout
}

function askWithFileSearch_(apiKey, storeName, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${CONFIG.MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: userText }]}],
    tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }]
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(body);
  throw new Error(`generateContent failed: ${code} ${body}`);
}

function deleteFileSearchStore_(apiKey, storeName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${storeName}?key=${encodeURIComponent(apiKey)}`;
  const res = UrlFetchApp.fetch(url, { method: 'delete', muteHttpExceptions: true });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code >= 200 && code < 300) { Logger.log(`✔ store deleted: ${storeName}`); return true; }
  Logger.log(`delete store failed: ${code} ${body}`); return false;
}

//////////////////// Drive ユーティリティ ////////////////////
function driveListFilesInFolder_(folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const fields = 'files(id,name,mimeType,modifiedTime)';
  const token = ScriptApp.getOAuthToken();
  let pageToken = '', out = [];
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${pageToken ? '&pageToken='+pageToken : ''}`;
    const res = UrlFetchApp.fetch(url, {
      method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true,
    });
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

  // Google系は export
  if (CONFIG.EXPORT_MIMES[mime]) {
    const exportMime = CONFIG.EXPORT_MIMES[mime];
    const url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = UrlFetchApp.fetch(url, {
      method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) { Logger.log('Export failed:', name, res.getContentText()); return null; }
    const bytes = res.getContent();
    const ext = exportMime === 'application/pdf' ? '.pdf' : exportMime === 'text/csv' ? '.csv' : '';
    return { name: name + ext, contentType: exportMime, bytes };
  }

  // その他は alt=media
  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true,
  });
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

//////////////////// Flex Message ビルダー ////////////////////
// 情報/進捗（バー付き）
function flexInfoBubble(title, subtitle, percent, footnote) {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg' },
        { type: 'text', text: subtitle || '', wrap: true, color: '#666666' },
        progressBar_(percent),
        footnote ? { type: 'text', text: footnote, size: 'sm', color: '#999999', wrap: true } : { type: 'box', layout: 'baseline', contents: [] }
      ]
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        quickButton_('取り込み'), quickButton_('要約')
      ]
    }
  };
}

// 成功通知
function flexSuccessBubble(title, subtitle, footnote) {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: '✅ ' + title, weight: 'bold', size: 'lg', color: '#0A7D32' },
        { type: 'text', text: subtitle || '', wrap: true },
        { type: 'text', text: footnote || '', wrap: true, color: '#666666' }
      ]
    },
    footer: { type: 'box', layout: 'horizontal', contents: [ quickButton_('要約') ] }
  };
}

// エラー通知
function flexErrorBubble(message) {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: '⚠ エラー', weight: 'bold', size: 'lg', color: '#B00020' },
        { type: 'text', text: message, wrap: true, color: '#666666' }
      ]
    },
    footer: { type: 'box', layout: 'horizontal', contents: [ quickButton_('取り込み') ] }
  };
}

// 回答カード（要約＋根拠リンク）
function flexAnswerBubble(question, answerPreview, citations) {
  const citeItems = (citations || []).map((u, i) => ({
    type: 'text',
    text: `［${i+1}］ ${u}`,
    size: 'sm',
    color: '#4a7bd3',
    wrap: true
  }));
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '回答', weight: 'bold', size: 'lg' },
        { type: 'text', text: 'Q: ' + truncate_(question, 120), size: 'sm', color: '#666666', wrap: true }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: answerPreview, wrap: true },
        (citeItems.length > 0) ? { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '— 根拠 —', weight: 'bold', size: 'sm' },
          ...citeItems
        ]} : { type: 'box', layout: 'vertical', contents: [] }
      ]
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        quickButton_('取り込み'),
        quickButton_('要約')
      ]
    }
  };
}

// 共通パーツ
function progressBar_(percent) {
  const pct = clamp_(Math.round(percent || 0), 0, 100);
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      { type: 'box', layout: 'vertical', contents: [{ type: 'filler' }], height: '8px', backgroundColor: '#e0e0e0', cornerRadius: 'sm' },
      {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'filler' }],
        height: '8px',
        backgroundColor: '#4a7bd3',
        cornerRadius: 'sm',
        position: 'absolute',
        width: pct + '%'
      }
    ],
    position: 'relative',
    margin: 'md'
  };
}

function quickButton_(label) {
  return {
    type: 'button',
    style: 'link',
    action: { type: 'message', label, text: label }
  };
}

function clamp_(v, min, max) { return Math.max(min, Math.min(max, v)); }
function truncate_(s, n) { if (!s) return s; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

