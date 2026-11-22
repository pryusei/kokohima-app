// Vite の ?raw の取り込み（設定ファイルの中身をテストで確かめるため。src/http/health.test.ts）
declare module "*?raw" {
  const content: string;
  export default content;
}
