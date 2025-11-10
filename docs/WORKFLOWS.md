# 🔄 運用ワークフロー

## 🚀 本番リリース手順
1. Apps Script エディタで `main` ブランチを最新化 (Clasp 等を利用する場合は `clasp pull`)。
2. `.env` ではなく、GAS の **スクリプトプロパティ**に下記キーを登録:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_TOKEN`
   - `GEMINI_API_KEY`
   - `TARGET_DRIVE_FOLDER_ID`
3. 「デプロイ」>「新しいデプロイ」から Web アプリとして公開し、LINE の Webhook URL を更新。
4. LINE Developers コンソールで接続確認を実行し、ステータス 200 を確認。

## 🧪 テストのすすめ
- GAS の `doPost` をモックする Google Apps Script テスト関数を作成し、Drive / Gemini 呼び出しのハッピーパスを確認します。
- LINE の Messaging API シミュレータを使用して、実際のユーザー対話を再現します。
- Drive API のクオータ使用量が閾値に近づいた場合は、検索対象フォルダを絞るなど対策を検討します。

## 📊 運用監視
- Apps Script の実行ログと Stackdriver Logging を活用して例外を監視します。
- エラー率やレスポンス時間を週次でレビューし、必要に応じて Gemini のプロンプトや検索アルゴリズムを調整します。

## 🛠️ トラブルシューティング
| 症状 | 原因 | 対応 |
| --- | --- | --- |
| LINE から応答が返らない | チャネルシークレットの不一致 | LINE Developers の資格情報を再設定し、GAS プロパティを更新 |
| ドライブ検索が空になる | フォルダ ID またはアクセス権の誤り | 対象フォルダの共有設定を確認し、必要に応じてサービスアカウントに権限付与 |
| Gemini API からエラー | API キーの権限不足またはクオータ超過 | Google AI Studio でキーと使用量を確認し、必要に応じてリトライ制御を追加 |

## 🧭 ナレッジシェア
- プロジェクトの詳細なアーキテクチャは [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) を参照してください。
- 新しい検索プロンプト案や改善提案は GitHub Issues でトラッキングし、議論を残します。
