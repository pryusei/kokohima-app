import { createWorker } from "./worker";

// 本番のエントリ。src/e2e/ をimportしないこと（CIでビルド成果物を検査している）
export default createWorker().handler;
