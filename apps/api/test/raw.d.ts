// テストで、ファイルの中身を文字列として読む（Vite の ?raw）。wrangler の設定の検査に使う
declare module "*?raw" {
  const text: string;
  export default text;
}
