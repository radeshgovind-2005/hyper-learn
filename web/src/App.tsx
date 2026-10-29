import { UserButton, useAuth } from "@clerk/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CoursePanel } from "./components/CoursePanel.js";
import { Drawer } from "./components/Drawer.js";
import { HistoryDrawer } from "./components/HistoryDrawer.js";
import { LessonView } from "./components/LessonView.js";
import { RepairDrawer } from "./components/RepairDrawer.js";
import { MyProgress } from "./pages/MyProgress.js";
import type { AgentState, Call, CourseSnapshot, LessonProgress, Me, Overview } from "./types.js";

type DrawerName = "repair" | "history" | null;

export function App() {
  const { getToken, userId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const onProgressPage = location.pathname === "/me";
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [lessonId, setLessonId] = useState("agent-loop");
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CourseSnapshot | null>(null);
  const [parent, setParent] = useState<CourseSnapshot | null>(null);
  const [progress, setProgress] = useState<LessonProgress[]>([]);
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const [navOpen, setNavOpen] = useState(false);

  // The connection carries this person's Clerk session token; the Worker verifies it before the agent
  // sees anything. Tokens live about a minute, so a cached one is reused for at most 30 s on reconnect.
  const query = useCallback(async () => ({ token: (await getToken()) ?? "" }), [getToken]);
  const agent = useAgent<AgentState>({
    agent: "course-agent",
    name: "agentic-coding",
    query,
    queryDeps: [userId],
    cacheTtl: 30_000,
    onStateUpdate: (state) => state.overview && setOverview(state.overview),
  });
  const call: Call = useCallback((method, args = []) => agent.call(method, args), [agent]);

  useEffect(() => {
    if (!agent.identified) return;
    void call<Me>("me").then(setMe);
    void call<Overview>("overview").then(setOverview);
    void call<LessonProgress[]>("progress").then(setProgress);
  }, [call, agent.identified]);
  const mayRepair = me?.permissions.includes("repair") ?? false;

  // When a run starts waiting for a human, bring its approval card into view (for people who may approve).
  const status = overview?.run?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (mayRepair && status === "awaiting_approval" && previous.current !== "awaiting_approval") setDrawer("repair");
    previous.current = status;
  }, [status, mayRepair]);

  // The release on screen: the live one, or one picked from the history (with its parent, to show what changed).
  const shown = viewVersion ?? overview?.live;
  const shownParent = overview?.releases.find((r) => r.version === shown)?.parent ?? null;
  useEffect(() => {
    if (!shown) return;
    void call<CourseSnapshot>("snapshot", [shown]).then(setSnapshot);
    if (viewVersion && shownParent) void call<CourseSnapshot>("snapshot", [shownParent]).then(setParent);
    else setParent(null);
  }, [call, shown, shownParent, viewVersion]);

  const refreshProgress = useCallback(() => void call<LessonProgress[]>("progress").then(setProgress), [call]);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const toggle = (name: Exclude<DrawerName, null>) => setDrawer((d) => (d === name ? null : name));
  const openLesson = (id: string) => {
    setLessonId(id);
    setNavOpen(false);
    if (location.pathname !== "/") navigate("/");
  };

  const running = status === "running";
  const waiting = status === "awaiting_approval";

  return (
    <div className="app">
      <header className="header">
        <button className="icon-btn menu-btn" onClick={() => setNavOpen((o) => !o)} aria-label="Learning path">
          ☰
        </button>
        <div className="brand">
          <img src="/meta-logo.svg" alt="Meta" />
          <span className="divider" />
          <span className="name">HyperLearn</span>
        </div>
        <span className="spacer" />
        <button className={`btn sm ${onProgressPage ? "primary" : "quiet"}`} onClick={() => navigate(onProgressPage ? "/" : "/me")} aria-current={onProgressPage ? "page" : undefined}>
          My progress
        </button>
        {overview && (
          <button className="chip blue" onClick={() => toggle("history")} title="Release history">
            v{overview.live}
          </button>
        )}
        {mayRepair && (
          <button className={`btn sm ${drawer === "repair" ? "primary" : "secondary"} header-btn`} onClick={() => toggle("repair")} aria-expanded={drawer === "repair"}>
            {running && <span className="spinner" />}
            {waiting ? "Approval needed" : "Course repair"}
            {waiting && drawer !== "repair" && <span className="badge-dot" />}
          </button>
        )}
        {me && me.role !== "learner" && <span className="chip">{me.role}</span>}
        <span className="account" title={agent.identified ? "connected" : "connecting…"}>
          <UserButton />
          <span className={`status ${agent.identified ? "on" : ""}`} />
        </span>
      </header>

      <div className="body">
        <nav className={`sidebar ${navOpen ? "open" : ""}`} aria-label="Learning path">
          <CoursePanel snapshot={snapshot} lessonId={lessonId} onSelectLesson={openLesson} progress={progress} />
        </nav>

        <main className="main">
          {onProgressPage ? (
            <MyProgress key={progress.length} call={call} onOpenLesson={openLesson} />
          ) : snapshot ? (
            <LessonView
              // Keyed by lesson, not version: a release going live mid-quiz updates the page without wiping the learner's answers.
              key={`${viewVersion ?? "live"}:${lessonId}`}
              snapshot={snapshot}
              parent={parent}
              lessonId={lessonId}
              viewingHistory={viewVersion !== null && viewVersion !== overview?.live}
              onBackToLive={() => setViewVersion(null)}
              approvalWaiting={mayRepair && waiting && drawer !== "repair" ? (overview?.run?.approval?.version ?? null) : null}
              onReviewApproval={() => setDrawer("repair")}
              call={call}
              onAnswered={refreshProgress}
              onOpenLesson={openLesson}
            />
          ) : (
            <div className="empty">Loading the course…</div>
          )}
        </main>

        <Drawer open={mayRepair && drawer === "repair"} title="Course repair" onClose={closeDrawer}>
          <RepairDrawer
            overview={overview}
            mayReset={me?.permissions.includes("reset") ?? false}
            call={call}
            onReset={() => {
              setViewVersion(null);
              refreshProgress();
            }}
            onView={(v) => {
              setViewVersion(v);
            }}
          />
        </Drawer>
        <Drawer open={drawer === "history"} title="Releases" onClose={closeDrawer}>
          <HistoryDrawer
            overview={overview}
            viewing={viewVersion ?? overview?.live ?? null}
            onView={(v) => {
              setViewVersion(v === overview?.live ? null : v);
              setDrawer(null);
            }}
          />
        </Drawer>
      </div>
    </div>
  );
}
