import { googleCalendarAddUrl, type Meetup } from "@kokohima/shared";
import { useId, useState } from "react";
import { buttonClass } from "../ui/Button";
import { Collapse } from "../ui/Collapse";
import { Note } from "../ui/feedback";
import { currentDeviceCalendarLabel } from "./deviceCalendar";
import { IcsButton } from "./IcsButton";

// 成立した予定のカレンダーへの入れ方の欄（docs/specs/T-59-choose-calendar-add.md「振る舞い 1.」）。
// 「カレンダーに追加」を押すと、すぐ下に「Googleカレンダーに追加」と端末のカレンダー（.ics）がその場で開く（シートを重ねない）。
// アプリから Google に自動で書くことはしないので、連携の状態は読まない。
// 成立した予定の詳細と、成立の演出の中（誘いの詳細・募集の詳細。T-43）で使う

const ROW = "flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left font-bold text-ink";

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function MeetupCalendarActions({ meetup }: { meetup: Meetup }) {
  // 画面を開いた時刻と端末で1回だけ判定する（描画のたびに時計や端末を読まない）
  const [openedAt] = useState(() => Date.now());
  const [deviceLabel] = useState(currentDeviceCalendarLabel);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // 入れられるのは、成立中で、まだ終わっていない予定だけ
  if (meetup.status !== "confirmed" || Date.parse(meetup.endsAt) <= openedAt) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-m border border-line-strong bg-surface">
        <button
          type="button"
          className={`${buttonClass("ghost", { block: true })} rounded-none`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <CalendarIcon />
          カレンダーに追加
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`transition-transform duration-(--duration-fast) ${open ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <Collapse show={open}>
          <div id={panelId} className="flex flex-col divide-y divide-line border-t border-line bg-surface-sunken">
            <a className={ROW} href={googleCalendarAddUrl(meetup, window.location.origin)} target="_blank" rel="noopener noreferrer">
              Googleカレンダーに追加
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
            </a>
            <div>
              <IcsButton meetupId={meetup.id} label={deviceLabel} className={ROW} />
            </div>
          </div>
        </Collapse>
      </div>
      {open && <Note>押した予定だけが入ります</Note>}
    </div>
  );
}
