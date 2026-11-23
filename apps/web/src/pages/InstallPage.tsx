import { promptInstall, useInstallMode } from "../install/install";
import { Button, buttonClass } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { SubScreen } from "../ui/Navigation";

// アプリとして使う（docs/specs/T-25-installable-pwa.md「/settings/install」）
// 自動のバナーは出さない。ブラウザに何も保存しない。追加できなくても赤やエラー色は使わない

const IOS_STEPS = ["Safari で開く", "共有のボタンを押す", "「ホーム画面に追加」を選ぶ", "ホーム画面のアイコンから開く"];

function NotificationLink() {
  return (
    <Link to="/settings/notifications" className={`${buttonClass("secondary", { block: true })} no-underline`}>
      通知の設定へ
    </Link>
  );
}

export function InstallPage() {
  const mode = useInstallMode();
  return (
    <SubScreen title="アプリとして使う" back="/settings">
      <div className="flex flex-col gap-3 rounded-l bg-surface p-4 shadow-card">
        {mode === "standalone" && (
          <>
            <p role="status">ホーム画面から開いています</p>
            <NotificationLink />
          </>
        )}
        {mode === "installed" && (
          <>
            <p role="status">ホーム画面に追加しました</p>
            <NotificationLink />
          </>
        )}
        {mode === "prompt" && (
          <>
            <p>ホーム画面に追加すると、すぐ開けて、通知も受け取れます</p>
            <Button variant="primary" block onClick={() => void promptInstall()}>
              ホーム画面に追加
            </Button>
          </>
        )}
        {mode === "ios" && (
          <>
            <p>ホーム画面に追加すると、通知を受け取れます</p>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {IOS_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </>
        )}
        {mode === "other" && (
          <>
            <p>ブラウザのメニューから、ホーム画面に追加（またはインストール）できます</p>
            <Note>うまく追加できないときは、Safari か Chrome で開き直してください</Note>
          </>
        )}
      </div>
    </SubScreen>
  );
}
