// Workers のバインディングと環境変数
export type Bindings = {
  DB: D1Database;
  E2E_MODE?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
