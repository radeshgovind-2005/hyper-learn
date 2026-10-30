import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CoursePanel } from "./components/CoursePanel.js";
import { CourseSwitcher } from "./components/CourseSwitcher.js";
import { AskForm, EditStatus } from "./components/EditPanel.js";
import { Drawer } from "./components/Drawer.js";
import { HistoryDrawer } from "./components/HistoryDrawer.js";
import { LessonView } from "./components/LessonView.js";
import { RepairDrawer } from "./components/RepairDrawer.js";
import { Shell } from "./components/Shell.js";
import { TuneButton } from "./components/TuneButton.js";
import { type SourceTarget, SourceViewer } from "./components/SourceViewer.js";
import { coursePath, type Directory, FEATURED_COURSE, useDirectory, useSessionQuery } from "./directory.js";
import { Coach } from "./pages/Coach.js";
import { CreateCourse } from "./pages/CreateCourse.js";
import { JoinCourse } from "./pages/JoinCourse.js";
import { LearnerDetail, Learners } from "./pages/Learners.js";
import { MyProgress } from "./pages/MyProgress.js";
import { Studio } from "./pages/Studio.js";
import type { AgentState, Call, CitedSource, CourseSnapshot, LessonProgress, Me, Overview, ServedRelease } from "./types.js";

type Route =
  | { page: "new" }
  | { page: "join"; course: string; token: string }
  /** `base` is the course's path prefix ("" for the featured course); `rest` is the page within it. */
  | { page: "course"; course: string; base: string; rest: string };

function routeOf(pathname: string): Route {
  if (pathname === "/new") return { page: "new" };
  const join = /^\/join\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (join) return { page: "join", course: decodeURIComponent(join[1]!), token: decodeURIComponent(join[2]!) };
  const course = /^\/c\/([^/]+)(\/.*)?$/.exec(pathname);
  if (course) {
    const id = decodeURIComponent(course[1]!);
    return { page: "course", course: id, base: coursePath(id).replace(/\/$/, ""), rest: course[2] ?? "" };
  }
  return { page: "course", course: FEATURED_COURSE, base: "", rest: pathname === "/" ? "" : pathname };
}

/** The signed-in app: the directory connection, and whichever page the URL names. */
export function App() {
  const location = useLocation();
  const directory = useDirectory();
  const route = routeOf(location.pathname);

  if (route.page === "course") {
    // Keyed by course, so switching courses opens a fresh connection and fresh page state.
    return <CourseApp key={route.course} courseId={route.course} base={route.base} rest={route.rest} directory={directory} />;
  }
  return (
    <Shell connected={directory.ready} navKey={location.pathname} sidebar={<CourseSwitcher courses={directory.courses} current={null} />}>
      {route.page === "new" ? <CreateCourse directory={directory} /> : <JoinCourse directory={directory} courseId={route.course} token={route.token} />}
    </Shell>
  );
}

type DrawerName = "repair" | "history" | "source" | null;

/** The lesson a course opens on: the featured course's demo starts at the agent loop, others at lesson 1. */
const START_LESSON: Record<string, string> = { [FEATURED_COURSE]: "agent-loop" };

function CourseApp({ courseId, base, rest, directory }: { courseId: string; base: string; rest: string; directory: Directory }) {
  const navigate = useNavigate();
  const go = useCallback((path: string) => navigate(`${base}${path}` || "/"), [navigate, base]);
  const onProgressPage = rest === "/me";
  const onStudioPage = rest === "/studio";
  const onCoachPage = rest === "/coach";
  const learnerMatch = /^\/learners(?:\/([^/]+))?$/.exec(rest);
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [chosenLesson, setChosenLesson] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const [served, setServed] = useState<ServedRelease | null>(null);
  const [snapshot, setSnapshot] = useState<CourseSnapshot | null>(null);
  const [parent, setParent] = useState<CourseSnapshot | null>(null);
  const [progress, setProgress] = useState<LessonProgress[]>([]);
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const [refused, setRefused] = useState<string | null>(null);

  // Tokens live about a minute, so a cached one is reused for at most 30 s on reconnect. The server closes
  // with 40xx when someone may not enter (not a member, unknown course): that is final, so don't retry.
  const { query, userId } = useSessionQuery();
  const agent = useAgent<AgentState>({
    agent: "course-agent",
    name: courseId,
    query,
    queryDeps: [userId],
    cacheTtl: 30_000,
    shouldReconnectOnClose: (event) => event.code < 4000 || event.code >= 5000,
    onConnectionError: (error) => setRefused(error.reason || "You can't open this course."),
    onStateUpdate: (state) => state.overview && setOverview(state.overview),
  });
  const call: Call = useCallback((method, args = []) => agent.call(method, args), [agent]);

  const published = overview ? overview.live !== null : null;
  useEffect(() => {
    if (!agent.identified) return;
    void call<Me>("me").then(setMe);
    void call<Overview>("overview").then(setOverview);
  }, [call, agent.identified]);
  useEffect(() => {
    if (agent.identified && published) void call<LessonProgress[]>("progress").then(setProgress);
  }, [call, agent.identified, published]);
  const mayRepair = me?.permissions.includes("repair") ?? false;
  const mayViewLearners = me?.permissions.includes("view_learners") ?? false;
  const mayManage = (me?.permissions.includes("manage_course") ?? false) && courseId !== FEATURED_COURSE;

  // When a run starts waiting for a human, bring its approval card into view (for people who may approve).
  const status = overview?.run?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (mayRepair && status === "awaiting_approval" && previous.current !== "awaiting_approval") setDrawer("repair");
    previous.current = status;
  }, [status, mayRepair]);

  // The release this person is served: the live one, or during a trial on real learners, possibly the trial.
  const live = overview?.live;
  const trialVersion = overview?.trial?.version;
  useEffect(() => {
    if (!agent.identified || !live) return;
    void call<ServedRelease>("myRelease").then(setServed);
  }, [call, agent.identified, live, trialVersion]);
  const home = served?.version ?? live;

  // The files this person may open from citation chips: the ones their release cites (the featured course has none).
  const [cited, setCited] = useState<ReadonlyMap<string, CitedSource>>(new Map());
  useEffect(() => {
    if (!agent.identified || !home || courseId === FEATURED_COURSE) return;
    void call<CitedSource[]>("citedSources")
      .then((list) => setCited(new Map(list.map((s) => [s.id, s]))))
      .catch(() => setCited(new Map()));
  }, [call, agent.identified, home, courseId]);

  // A source page in the drawer. `opened` counts openings, so opening another citation starts the viewer afresh.
  const [source, setSource] = useState<{ target: SourceTarget; opened: number } | null>(null);
  const openSource = useCallback((target: SourceTarget) => {
    setSource((s) => ({ target, opened: (s?.opened ?? 0) + 1 }));
    setDrawer("source");
  }, []);
  // The course object closes every connection (4004) as it wipes itself; then the lists refresh and we leave.
  const deleteCourse = async () => {
    await directory.call("deleteCourse", [courseId]);
    directory.refresh();
    navigate("/");
  };
  const citations = useMemo(
    () => ({ sources: cited, open: (s: CitedSource, page: number, passage: string) => openSource({ source: s, page, passage, owner: false }) }),
    [cited, openSource],
  );

  // The release on screen: the served one, or one picked from the history (with its parent, to show what changed).
  const shown = viewVersion ?? home;
  const shownParent = overview?.releases.find((r) => r.version === shown)?.parent ?? null;
  useEffect(() => {
    if (!shown) return;
    void call<CourseSnapshot>("snapshot", [shown]).then(setSnapshot);
    if (viewVersion && shownParent) void call<CourseSnapshot>("snapshot", [shownParent]).then(setParent);
    else setParent(null);
  }, [call, shown, shownParent, viewVersion]);

  const lessons = snapshot?.lessons.filter((l) => !l.archived) ?? [];
  const lessonId = chosenLesson ?? (lessons.some((l) => l.id === START_LESSON[courseId]) ? START_LESSON[courseId]! : (lessons[0]?.id ?? ""));

  const refreshProgress = useCallback(() => void call<LessonProgress[]>("progress").then(setProgress), [call]);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const toggle = (name: Exclude<DrawerName, null>) => setDrawer((d) => (d === name ? null : name));
  const openLesson = (id: string) => {
    setChosenLesson(id);
    if (rest !== "") go("");
  };
  // After the lesson renders, bring the section into view (a "review §…" step).
  const openSection = (lesson: string, section: string) => {
    openLesson(lesson);
    setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const running = status === "running";
  const waiting = status === "awaiting_approval";
  const title = overview?.course.title || snapshot?.title;
  // Studio courses can be edited in words by whoever may repair them (owner, editors, admins).
  const editable = mayRepair && courseId !== FEATURED_COURSE;
  const edit = overview?.edit ?? null;
  const editBusy = edit?.status === "running";

  const actions = (
    <>
      {mayManage && (
        <button className={`btn sm ${onStudioPage ? "primary" : "quiet"}`} onClick={() => go(onStudioPage ? "" : "/studio")} aria-current={onStudioPage ? "page" : undefined}>
          Studio
        </button>
      )}
      {published && mayViewLearners && (
        <button className={`btn sm ${learnerMatch ? "primary" : "quiet"}`} onClick={() => go(learnerMatch ? "" : "/learners")} aria-current={learnerMatch ? "page" : undefined}>
          Learners
        </button>
      )}
      {published && (
        <button className={`btn sm ${onCoachPage ? "primary" : "quiet"}`} onClick={() => go(onCoachPage ? "" : "/coach")} aria-current={onCoachPage ? "page" : undefined}>
          Study coach
        </button>
      )}
      {published && (
        <button className={`btn sm ${onProgressPage ? "primary" : "quiet"}`} onClick={() => go(onProgressPage ? "" : "/me")} aria-current={onProgressPage ? "page" : undefined}>
          My progress
        </button>
      )}
      {home && (
        <button className="chip blue" onClick={() => toggle("history")} title={served?.arm ? "Release history · a trial is running, and you're in it" : "Release history"}>
          v{home}
        </button>
      )}
      {published && mayRepair && (
        <button className={`btn sm ${drawer === "repair" ? "primary" : "secondary"} header-btn`} onClick={() => toggle("repair")} aria-expanded={drawer === "repair"}>
          {running && <span className="spinner" />}
          {waiting ? "Approval needed" : "Course repair"}
          {waiting && drawer !== "repair" && <span className="badge-dot" />}
        </button>
      )}
      {me && me.role !== "learner" && <span className="chip">{me.role}</span>}
    </>
  );

  let page;
  if (refused) {
    page = (
      <div className="page narrow stack">
        <h1>Can't open this course</h1>
        <div className="notice">{refused}</div>
        <div className="row">
          <button className="btn secondary" onClick={() => navigate("/")}>
            Go to the featured course
          </button>
        </div>
      </div>
    );
  } else if (onStudioPage && mayManage) {
    page = (
      <Studio
        call={call}
        overview={overview}
        courseId={courseId}
        onOpenSource={openSource}
        onDelete={deleteCourse}
        onPublished={() => {
          directory.refresh();
          go("");
        }}
      />
    );
  } else if (published === false) {
    // A course that isn't published yet: its owner works on it in the studio; anyone else waits.
    page = mayManage ? (
      <Studio call={call} overview={overview} courseId={courseId} onOpenSource={openSource} onDelete={deleteCourse} onPublished={() => directory.refresh()} />
    ) : me ? (
      <div className="page narrow">
        <h1>{title}</h1>
        <p className="lede">This course isn't published yet. You'll find it here once its owner publishes it.</p>
      </div>
    ) : (
      <div className="empty">Loading the course…</div>
    );
  } else if (onCoachPage && snapshot) {
    page = <Coach key={courseId} call={call} snapshot={snapshot} lessonId={lessonId} citations={citations} onOpenLesson={openLesson} onOpenSection={openSection} />;
  } else if (onProgressPage) {
    page = <MyProgress key={progress.length} call={call} onOpenLesson={openLesson} />;
  } else if (learnerMatch && mayViewLearners) {
    page = learnerMatch[1] ? (
      <LearnerDetail
        call={call}
        userId={decodeURIComponent(learnerMatch[1])}
        onBack={() => go("/learners")}
        roles={me?.permissions.includes("manage_roles") ? { self: me.userId, configured: me.rolesConfigured } : null}
      />
    ) : (
      <Learners call={call} onOpen={(id) => go(`/learners/${encodeURIComponent(id)}`)} />
    );
  } else if (snapshot) {
    page = (
      <LessonView
        // Keyed by lesson, not version: a release going live mid-quiz updates the page without wiping the learner's answers.
        key={`${viewVersion ?? "live"}:${lessonId}`}
        snapshot={snapshot}
        parent={parent}
        lessonId={lessonId}
        mode={viewVersion !== null && viewVersion !== home ? "history" : "learn"}
        onBackToLive={() => setViewVersion(null)}
        approvalWaiting={mayRepair && waiting && drawer !== "repair" ? (overview?.run?.approval?.version ?? null) : null}
        onReviewApproval={() => setDrawer("repair")}
        call={call}
        onAnswered={refreshProgress}
        onOpenLesson={openLesson}
        onOpenSection={openSection}
        onCoach={(id) => {
          setChosenLesson(id);
          go("/coach");
        }}
        {...(editable && { sectionTools: (section) => <TuneButton call={call} sectionId={section.id} busy={editBusy} onRequested={() => setDrawer("repair")} /> })}
        citations={citations}
      />
    );
  } else {
    page = <div className="empty">Loading the course…</div>;
  }

  return (
    <Shell
      connected={agent.identified}
      navKey={`${rest}:${lessonId}`}
      actions={actions}
      sidebar={
        <>
          <CourseSwitcher courses={directory.courses} current={courseId} currentTitle={title} />
          {published && <CoursePanel snapshot={snapshot} lessonId={lessonId} onSelectLesson={openLesson} progress={progress} />}
        </>
      }
      drawers={
        <>
          <Drawer open={mayRepair && drawer === "repair"} title="Course repair" onClose={closeDrawer}>
            {editable && (
              <section className="ask-change stack">
                <h3>Ask for a change</h3>
                <AskForm call={call} busy={editBusy} placeholder="e.g. Learners keep confusing NUMA and UMA: add a comparison and two questions on it." />
                <EditStatus call={call} edit={edit} published />
                <hr />
              </section>
            )}
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
              call={call}
              mayUndo={editable}
              viewing={viewVersion ?? home ?? null}
              onView={(v) => {
                setViewVersion(v === home ? null : v);
                setDrawer(null);
              }}
            />
          </Drawer>
          <Drawer open={drawer === "source" && source !== null} title={source?.target.source.name ?? "Source"} onClose={closeDrawer}>
            {source && <SourceViewer key={source.opened} call={call} target={source.target} />}
          </Drawer>
        </>
      }
    >
      {page}
    </Shell>
  );
}
