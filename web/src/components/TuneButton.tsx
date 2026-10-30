import { useState } from "react";
import type { Call } from "../types.js";
import { TuneForm } from "./EditPanel.js";

/** A small "Tune" toggle under a section title, opening the tune form in place. */
export function TuneButton({ call, sectionId, busy, onRequested }: { call: Call; sectionId: string; busy: boolean; onRequested?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section-tools">
      <button className="btn quiet sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        ✎ Tune this section
      </button>
      {open && (
        <TuneForm
          call={call}
          sectionId={sectionId}
          busy={busy}
          onDone={() => {
            setOpen(false);
            onRequested?.();
          }}
        />
      )}
    </div>
  );
}
