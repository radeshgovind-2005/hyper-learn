import { useAuth } from "@clerk/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type { Call, MyCourses } from "./types.js";

/** The featured course: shown at "/", every other course at "/c/<id>". */
export const FEATURED_COURSE = "agentic-coding";

export const coursePath = (id: string) => (id === FEATURED_COURSE ? "/" : `/c/${encodeURIComponent(id)}`);

/** The connection carries this person's Clerk session token; the Worker verifies it before any agent sees it. */
export function useSessionQuery() {
  const { getToken, userId } = useAuth();
  const query = useCallback(async () => ({ token: (await getToken()) ?? "" }), [getToken]);
  return { query, userId };
}

export interface Directory {
  call: Call;
  ready: boolean;
  /** Null until the first list arrives. */
  courses: MyCourses | null;
  refresh: () => void;
}

/** The one directory object: my courses, creating one, joining one with an invite. */
export function useDirectory(): Directory {
  const { query, userId } = useSessionQuery();
  const agent = useAgent({ agent: "directory-agent", name: "main", query, queryDeps: [userId], cacheTtl: 30_000 });
  const call: Call = useCallback((method, args = []) => agent.call(method, args), [agent]);
  const [courses, setCourses] = useState<MyCourses | null>(null);
  const refresh = useCallback(() => {
    void call<MyCourses>("myCourses")
      .then(setCourses)
      .catch(() => {});
  }, [call]);
  useEffect(() => {
    if (agent.identified) refresh();
  }, [agent.identified, refresh]);
  return { call, ready: agent.identified, courses, refresh };
}
