// SQL がインデックスを使うかを確かめる道具（docs/specs/T-12-data-growth.md）。
// 本物の関数を呼び、その中で prepare された SQL と bind された値を記録して、EXPLAIN QUERY PLAN にかける

type Recorded = { sql: string; binds: unknown[] };

/** prepare された SQL を記録する D1。実行は本物の D1 に任せる */
export function recordingD1(d1: D1Database) {
  const recorded: Recorded[] = [];
  const wrap = (stmt: D1PreparedStatement, entry: Recorded): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...values: unknown[]) => {
            entry.binds = values;
            return wrap(target.bind(...values), entry);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const entry: Recorded = { sql, binds: [] };
          recorded.push(entry);
          return wrap(target.prepare(sql), entry);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, recorded };
}

/** EXPLAIN QUERY PLAN の各行の detail */
export async function queryPlan(d1: D1Database, entry: Recorded) {
  const { results } = await d1
    .prepare(`EXPLAIN QUERY PLAN ${entry.sql}`)
    .bind(...entry.binds)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

/** 表全体の読み取り（インデックスを使わない SCAN）と、並び替えのための一時的な B-tree */
export function fullScans(plan: string[]) {
  return plan.filter((d) => /^SCAN \w+$/.test(d.trim()) || /USE TEMP B-TREE FOR ORDER BY/.test(d));
}
