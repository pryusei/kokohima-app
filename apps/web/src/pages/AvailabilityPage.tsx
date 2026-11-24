import { WeekPlanner } from "../availability/WeekPlanner";
import { TabScreen } from "../ui/Navigation";
import { MyWishes } from "../wish/MyWishes";

// ここ暇タブ（docs/specs/T-55-availability-week-grid.md「画面」。協議のモックの案A）
// 上に週の帯（7日×昼・夕方・夜）と1行のリンク2つ（時間を細かく決めて入れる・くり返し）、下に行きたいの欄。
// スマホ（390×844）で、マス目・「取り消す」・「AIでお店を探す」の入口まで1画面に収め、件数で高さが伸びないようにする

export function AvailabilityPage() {
  return (
    <TabScreen title="ここ暇">
      <WeekPlanner />
      <MyWishes />
    </TabScreen>
  );
}
