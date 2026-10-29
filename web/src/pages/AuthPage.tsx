import { SignIn, SignUp } from "@clerk/react";
import { useEffect, useState } from "react";

// A small course network: lessons (large nodes) linked by prerequisites, sections around them.
const LESSONS = [
  { id: "l1", x: 70, y: 150 },
  { id: "l2", x: 150, y: 80 },
  { id: "l3", x: 245, y: 58 },
  { id: "l4", x: 160, y: 218 },
  { id: "l5", x: 288, y: 168 }, // the lesson that struggles, then gets repaired
  { id: "l6", x: 362, y: 238 },
];
const SECTIONS = [
  { x: 36, y: 96, to: "l1" },
  { x: 96, y: 210, to: "l1" },
  { x: 118, y: 34, to: "l2" },
  { x: 200, y: 128, to: "l2" },
  { x: 305, y: 24, to: "l3" },
  { x: 222, y: 266, to: "l4" },
  { x: 344, y: 112, to: "l5" },
  { x: 398, y: 186, to: "l6" },
  { x: 308, y: 284, to: "l6" },
];
const PREREQS: [string, string][] = [
  ["l1", "l2"],
  ["l2", "l3"],
  ["l1", "l4"],
  ["l4", "l5"],
  ["l5", "l6"],
];
const REPAIR: [string, string] = ["l3", "l5"]; // the missing prerequisite the agents add

const at = (id: string) => LESSONS.find((l) => l.id === id)!;
const segment = ([a, b]: [string, string]) => `M${at(a).x} ${at(a).y} L${at(b).x} ${at(b).y}`;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * The product in one picture: a course network where signals flow along prerequisites; one lesson starts
 * to struggle, the agents add the missing prerequisite, and it recovers. Shown repaired and still when the
 * system asks for reduced motion.
 */
function CourseNetwork() {
  const still = useReducedMotion();
  const repairPath = segment(REPAIR);
  return (
    <svg
      className={`network ${still ? "still" : ""}`}
      viewBox="0 0 430 300"
      role="img"
      aria-label="A course network: one lesson struggles, agents add a missing prerequisite, and it recovers"
    >
      {SECTIONS.map((s, i) => (
        <line key={`se${i}`} x1={s.x} y1={s.y} x2={at(s.to).x} y2={at(s.to).y} className="edge thin" />
      ))}
      {PREREQS.map((e) => (
        <path key={e.join()} d={segment(e)} className="edge" />
      ))}
      <path d={repairPath} className="edge repair" pathLength={1} />

      {!still &&
        PREREQS.map((e, i) => (
          <circle key={`p${e.join()}`} r="3.2" className="pulse">
            <animateMotion dur="2.6s" begin={`${i * 0.5}s`} repeatCount="indefinite" path={segment(e)} />
          </circle>
        ))}
      {!still && (
        <circle r="3.6" className="pulse repair-pulse">
          <animateMotion dur="8s" repeatCount="indefinite" path={repairPath} keyPoints="0;0;1;1" keyTimes="0;0.55;0.85;1" calcMode="linear" />
          <animate attributeName="opacity" dur="8s" repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;0.54;0.56;0.84;1" />
        </circle>
      )}

      {SECTIONS.map((s, i) => (
        <circle key={`s${i}`} cx={s.x} cy={s.y} r="4" className="node small" />
      ))}
      {LESSONS.map((l) => (
        <circle key={l.id} cx={l.x} cy={l.y} r={l.id === "l5" ? 11 : 9} className={`node lesson ${l.id === "l5" ? "struggling" : ""}`} />
      ))}
    </svg>
  );
}

/** The front door: one idea on the left, Clerk's sign-in or sign-up on the right. */
export function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  return (
    <div className="auth">
      <section className="auth-brand" aria-label="HyperLearn">
        <div className="brand">
          <img className="app-logo" src="/hyperlearn-logo.png" alt="HyperLearn" />
        </div>
        <div className="auth-hero">
          <h1>Learning that sharpens itself.</h1>
          <p>Every wrong answer teaches the course how to teach better.</p>
          <CourseNetwork />
        </div>
        <div className="auth-credit">
          <img src="/meta-logo-black.svg" alt="Meta" />
          <span>Global AI Developer Hackathon</span>
        </div>
      </section>
      <section className="auth-form">
        {mode === "sign-in" ? (
          <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
        ) : (
          <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
        )}
      </section>
    </div>
  );
}
