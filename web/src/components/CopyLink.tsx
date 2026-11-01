import { useState } from "react";
import { hashOf } from "../deeplink.js";
import "../styles/viewer.css";

/** "Copy link" under a section's title: the course URL with `#<lesson>/<section>`, which opens right there. */
export function CopyLink({ sectionId }: { sectionId: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}${hashOf(sectionId.split("/")[0]!, sectionId)}`;
  return (
    <button
      className="btn quiet sm copy-link"
      title={url}
      onClick={() =>
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}
