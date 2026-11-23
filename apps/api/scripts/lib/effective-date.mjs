// 制定日・改定日・公表日の行の検査（docs/specs/T-19-privacy-terms.md「5.」「8.」）。文字列だけを受け取る純粋な関数（node:fs を使わない）。
// テストは apps/api/test/effective-date.test.ts（Workers の project）で行う

/** ビルドした画面の JS に入る「制定日：」の数（apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE が1つだけ） */
export const EXPECTED_EFFECTIVE_DATE_LINES = 1;
/** 「改定日（効力が生じる日）：」の数の上限（REVISION_DATE_LINE は1つだけ。改定するまでは0） */
export const MAX_REVISION_DATE_LINES = 1;
/** 「公表日：」の数の上限（REVISION_NOTICE_LINE は予告の間だけ1つ。ほかのときは0） */
export const MAX_REVISION_NOTICE_LINES = 1;
/** 予告の期間（改定日 − 公表日）の日数の下限と上限 */
export const MIN_NOTICE_DAYS = 7;
export const MAX_NOTICE_DAYS = 30;

export const EFFECTIVE_DATE_LABEL = "制定日：";
export const REVISION_DATE_LABEL = "改定日（効力が生じる日）：";
export const REVISION_NOTICE_LABEL = "公表日：";
/** 前の形の改定日の行（決めたこと14で「改定日（効力が生じる日）：」に変えた）。残っていれば止める */
export const OLD_REVISION_DATE_LABEL = "改定日：";

const DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 暦にある日付か（2026年13月40日・2026年2月30日などは偽）。Date で作り直して、年月日が同じかで確かめる */
export function isCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** b − a の日数（{ year, month, day } どうし。Date.UTC で作った日付の差） */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

const count = (text, label) => text.split(label).length - 1;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** label（「制定日：」など）に続く、暦にある本物の日付（YYYY年M月D日）の一覧 */
function realDates(text, label) {
  const re = new RegExp(`${escape(label)}${DATE.source}`, "g");
  const dates = [];
  for (const m of text.matchAll(re)) {
    const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    if (isCalendarDate(date.year, date.month, date.day)) dates.push(date);
  }
  return dates;
}

/** 「制定日：」の数 */
export const countEffectiveDateLines = (text) => count(text, EFFECTIVE_DATE_LABEL);
/** 「制定日：」に本物の日付が続く数 */
export const countRealEffectiveDates = (text) => realDates(text, EFFECTIVE_DATE_LABEL).length;
/** 「改定日（効力が生じる日）：」の数 */
export const countRevisionDateLines = (text) => count(text, REVISION_DATE_LABEL);
/** 「改定日（効力が生じる日）：」に本物の日付が続く数 */
export const countRealRevisionDates = (text) => realDates(text, REVISION_DATE_LABEL).length;
/** 「公表日：」の数 */
export const countRevisionNoticeLines = (text) => count(text, REVISION_NOTICE_LABEL);
/** 「公表日：」に本物の日付が続く数 */
export const countRealRevisionNoticeDates = (text) => realDates(text, REVISION_NOTICE_LABEL).length;
/** 前の形の「改定日：」の数 */
export const countOldRevisionDateLines = (text) => count(text, OLD_REVISION_DATE_LABEL);

const sum = (texts, f) => texts.reduce((n, t) => n + f(t), 0);
const format = (d) => `${d.year}年${d.month}月${d.day}日`;
const LEGAL_TS = "apps/web/src/pages/legal.ts";

/**
 * dist の JS の中身（ファイルごとの文字列）を調べ、問題の説明を返す（なければ空）。
 * いつも：「制定日：」がちょうど1回、「改定日（効力が生じる日）：」と「公表日：」は0回か1回、改定日の行がないのに「公表日：」があれば止める、
 * 前の形の「改定日：」があれば止める。日付の大小は見ない（CI の結果が走らせた日で変わらないように）。
 * deploy が真なら、どれも本物の日付であることを求め、today（日本時間の今日。{ year, month, day }。ないと止める）と日付の大小を比べる：
 * 制定日 ≦ 今日。公表日の行があれば 制定日 ≦ 公表日（制定した日に最初の改定を予告できる。T-19 決めたこと16）、今日 ≦ 改定日、改定日 − 公表日 が7日以上30日以下で、
 * noticeAlreadyPublished（本番にこの予告の行がもう出ているか。check-web-dist.mjs が本番を読んで決める）が偽なら 公表日 ＝ 今日、
 * 真なら 公表日 ≦ 今日、分からなければ（undefined）止める。公表日の行がなければ 制定日 ＜ 改定日 ≦ 今日
 */
export function effectiveDateProblems(texts, { deploy, today, noticeAlreadyPublished }) {
  const problems = [];
  const lines = sum(texts, countEffectiveDateLines);
  let effectiveOk = lines === EXPECTED_EFFECTIVE_DATE_LINES;
  if (lines !== EXPECTED_EFFECTIVE_DATE_LINES) {
    problems.push(`「制定日：」が ${lines} 回あります（${EXPECTED_EFFECTIVE_DATE_LINES} 回のはず。${LEGAL_TS} の EFFECTIVE_DATE_LINE を1つの文字列で使う）`);
  } else if (deploy && sum(texts, countRealEffectiveDates) !== lines) {
    effectiveOk = false;
    problems.push(`制定日が決まっていません（${LEGAL_TS} の EFFECTIVE_DATE_LINE を「制定日：YYYY年M月D日」の、暦にある日付にする）`);
  }

  let datesOk = true;
  const old = sum(texts, countOldRevisionDateLines);
  if (old > 0) {
    datesOk = false;
    problems.push(`前の形の「改定日：」が ${old} 回あります（${LEGAL_TS} の REVISION_DATE_LINE は「改定日（効力が生じる日）：YYYY年M月D日」にする）`);
  }

  const revisions = sum(texts, countRevisionDateLines);
  const notices = sum(texts, countRevisionNoticeLines);
  if (revisions > MAX_REVISION_DATE_LINES) {
    datesOk = false;
    problems.push(`「改定日（効力が生じる日）：」が ${revisions} 回あります（${MAX_REVISION_DATE_LINES} 回まで。${LEGAL_TS} の REVISION_DATE_LINE を1つの文字列で使う）`);
  } else if (deploy && sum(texts, countRealRevisionDates) !== revisions) {
    datesOk = false;
    problems.push(`改定日が日付になっていません（${LEGAL_TS} の REVISION_DATE_LINE を「改定日（効力が生じる日）：YYYY年M月D日」の、暦にある日付にする）`);
  }
  if (notices > MAX_REVISION_NOTICE_LINES) {
    datesOk = false;
    problems.push(`「公表日：」が ${notices} 回あります（${MAX_REVISION_NOTICE_LINES} 回まで。${LEGAL_TS} の REVISION_NOTICE_LINE を1つの文字列で使う）`);
  } else if (notices > 0 && revisions === 0) {
    datesOk = false;
    problems.push(`改定日の行がないのに「公表日：」があります（${LEGAL_TS} の REVISION_DATE_LINE を入れるか、REVISION_NOTICE_LINE を null にする）`);
  } else if (deploy && sum(texts, countRealRevisionNoticeDates) !== notices) {
    datesOk = false;
    problems.push(`公表日が日付になっていません（${LEGAL_TS} の REVISION_NOTICE_LINE を「公表日：YYYY年M月D日（…）」の、暦にある日付にする）`);
  }

  if (!deploy) return problems;
  if (!today) {
    problems.push("今日の日付がないので、制定日・改定日・公表日と今日の大小を確かめられません");
    return problems;
  }
  const T = today;
  const [E] = effectiveOk ? texts.flatMap((t) => realDates(t, EFFECTIVE_DATE_LABEL)) : [];
  if (E && daysBetween(E, T) < 0) {
    problems.push(`制定日（${format(E)}）が今日（${format(T)}）より後です`);
  }
  if (!datesOk || revisions !== 1) return problems;
  const [R] = texts.flatMap((t) => realDates(t, REVISION_DATE_LABEL));
  const [P] = texts.flatMap((t) => realDates(t, REVISION_NOTICE_LABEL));
  if (P) {
    if (E && daysBetween(E, P) < 0) {
      problems.push(`公表日（${format(P)}）が制定日（${format(E)}）より前です`);
    }
    const notice = daysBetween(P, R);
    if (notice < MIN_NOTICE_DAYS || notice > MAX_NOTICE_DAYS) {
      problems.push(`予告の期間（公表日 ${format(P)} から改定日 ${format(R)} まで）が ${notice} 日です（${MIN_NOTICE_DAYS}日以上${MAX_NOTICE_DAYS}日以下にする）`);
    }
    if (daysBetween(T, R) < 0) {
      problems.push(`改定日（${format(R)}）を過ぎても予告の行が残っています（REVISION_NOTICE_LINE・PRIVACY_REVISION_CHANGES・TERMS_REVISION_CHANGES を null にする。docs/specs/T-19-privacy-terms.md「8.」の5）`);
    }
    if (noticeAlreadyPublished === undefined) {
      problems.push("本番にこの予告の行がもう出ているかが分からないので、公表日を確かめられません");
    } else if (!noticeAlreadyPublished && daysBetween(P, T) !== 0) {
      problems.push(`本番にまだこの予告の行が出ていないので、公表日（${format(P)}）は今日（${format(T)}）にする（初めて予告を出すデプロイの日が公表日。docs/specs/T-19-privacy-terms.md「8.」）`);
    } else if (noticeAlreadyPublished && daysBetween(P, T) < 0) {
      problems.push(`公表日（${format(P)}）が今日（${format(T)}）より後です（公表日はデプロイする日にする。docs/specs/T-19-privacy-terms.md「8.」）`);
    }
  } else {
    if (E && daysBetween(E, R) <= 0) {
      problems.push(`改定日（${format(R)}）が制定日（${format(E)}）より後になっていません`);
    }
    if (daysBetween(R, T) < 0) {
      problems.push(`改定日（${format(R)}）が今日（${format(T)}）より後なのに、予告の行がありません（REVISION_NOTICE_LINE で前もって知らせる。docs/specs/T-19-privacy-terms.md「8.」）`);
    }
  }
  return problems;
}

/** dist の JS から、予告の行（「公表日：YYYY年M月D日（…）」の全体）を取り出す。なければ null */
export function revisionNoticeLine(texts) {
  for (const t of texts) {
    const m = t.match(/公表日：\d{4}年\d{1,2}月\d{1,2}日（[^）"'`]*）/);
    if (m) return m[0];
  }
  return null;
}

const CONTACT_START_JSON = "packages/shared/src/contactStart.json";

/**
 * 問い合わせ（T-24）の変更が本番に出ているかの目印。
 * CONTACT_NOTICE_MARKER は「この改定で変わるところ」の問い合わせの行（legal.ts の PRIVACY_REVISION_CHANGES）の一部、
 * CONTACT_POLICY_MARKER はプライバシー ポリシーの本文（「5.」の Slack の見出し）の一部。文言を変えるときは、ここも直す（legal.test.tsx で確かめる）
 */
export const CONTACT_NOTICE_MARKER = "アプリの中の問い合わせのフォームを足したことに合わせて";
export const CONTACT_POLICY_MARKER = "Slack Technologies, LLC（米国）";

/**
 * 問い合わせの公開の日（docs/specs/T-24-contact.md「振る舞い 11.」）の検査。startDate は contactStart.json の値（"YYYY-MM-DD" か null）。
 * いつも：null か暦にある日付でなければ止める。deploy が真のとき（today は日本時間の今日）：
 * - 今日が startDate より前：予告の行（「公表日：」）がちょうど1つあり、改定日（効力が生じる日）が startDate と同じこと。
 *   予告がもう本番に出ている（noticeAlreadyPublished）なら、本番の JS に問い合わせの行（CONTACT_NOTICE_MARKER）も出ていること
 *   （予告の途中で問い合わせを足すと、その分の予告が短くなるため）。
 * - 今日が startDate 以後で、予告の行がある：改定日が startDate と同じこと。違うなら、問い合わせがもう本番の本文に出ている
 *   （CONTACT_POLICY_MARKER。前の改定で知らせ済み）ときだけ通す。
 * 本番を読めなかった（production が undefined）ときは、それが要る場合に止める
 */
export function contactStartProblems(texts, { startDate, deploy, today, noticeAlreadyPublished, production }) {
  if (startDate === null) return [];
  const m = typeof startDate === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate) : null;
  const start = m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
  if (!start || !isCalendarDate(start.year, start.month, start.day)) {
    return [`問い合わせの公開の日が日付になっていません（${CONTACT_START_JSON} の startDate を null か "YYYY-MM-DD" の暦にある日付にする）`];
  }
  if (!deploy) return [];
  if (!today) return ["今日の日付がないので、問い合わせの公開の日を確かめられません"];
  const notices = sum(texts, countRevisionNoticeLines);
  const revisions = texts.flatMap((t) => realDates(t, REVISION_DATE_LABEL));
  const sameDay = revisions.length === 1 && daysBetween(revisions[0], start) === 0;
  const mismatch = `問い合わせの公開の日（${format(start)}）が、プライバシー ポリシーの改定日（効力が生じる日）と違います（${CONTACT_START_JSON} の startDate と ${LEGAL_TS} の REVISION_DATE_LINE を同じ日にする）`;
  const problems = [];
  if (daysBetween(today, start) > 0) {
    if (!sameDay) problems.push(mismatch);
    if (notices !== 1) {
      problems.push(`問い合わせの公開の日（${format(start)}）より前なのに、予告の行（「公表日：」）がありません（${LEGAL_TS} の REVISION_NOTICE_LINE で前もって知らせる）`);
    } else if (noticeAlreadyPublished !== false && production?.notice !== true) {
      // 予告がもう出ている（か、本番を読めなかった）のに、本番の予告に問い合わせの行がない
      problems.push(
        `予告がもう本番に出ているのに、本番の「この改定で変わるところ」に問い合わせの行がありません（予告の途中で問い合わせを足すと予告が短くなる。公表日のデプロイで一緒に出すか、今の予告が終わってから次の改定にする。docs/specs/T-24-contact.md「10.」）`,
      );
    }
    return problems;
  }
  if (notices > 0 && !sameDay && production?.policy !== true) {
    problems.push(`${mismatch}。問い合わせがまだ本番のプライバシー ポリシーにないまま、問い合わせを始める日を過ぎています`);
  }
  return problems;
}

/** 日本時間の今日（{ year, month, day }）。now はミリ秒の時刻 */
export function jstToday(now) {
  const d = new Date(now + 9 * 60 * 60 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
