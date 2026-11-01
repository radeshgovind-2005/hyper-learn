# Demo course and pilot

## The material (A11)

The hackathon allows only material we have the rights to. The ComPar lectures belong to the university,
so they stay a private fallback and are never shown in the public video.

The demo course is built from Victor Eijkhout's lecture slides for *The Art of HPC, volume 1*:

| File | What it covers | Pages | Source |
| --- | --- | --- | --- |
| `hpc_scaling.pdf` | Collectives and their cost model (α, β, γ), speedup and efficiency, Amdahl's and Gustafson's laws, strong and weak scaling | 87 | [vol1/lectures/hpc_scaling.pdf](https://github.com/VictorEijkhout/TheArtofHPC_pdfs/blob/main/vol1/lectures/hpc_scaling.pdf) |
| `hpc_architecture.pdf` (optional second file) | Memory hierarchy, caches, multicore, NUMA | 56 | [vol1/lectures/hpc_architecture.pdf](https://github.com/VictorEijkhout/TheArtofHPC_pdfs/blob/main/vol1/lectures/hpc_architecture.pdf) |

**Licence.** The repository's README, checked 2026-11-01: "All materials are copyright Victor Eijkhout
2023, and released under a CC-by 4.0 license." ([TheArtofHPC_pdfs](https://github.com/VictorEijkhout/TheArtofHPC_pdfs),
[theartofhpc.com](https://theartofhpc.com)). CC BY 4.0 allows sharing and adapting, commercially too, with
attribution. So the course, the README and the video must say:

> Course material: Victor Eijkhout, *The Art of HPC*, volume 1 lecture slides, © 2023, CC BY 4.0
> (https://theartofhpc.com). Lessons generated from it by HyperLearn; changes were made.

Put that line in the course description when it is created, and in the video's end card.

**Why these slides.** They have what the "see" step is for: equations (the α + βn + γm cost model,
Amdahl's law), charts (speedup curves), tables, and diagrams of collectives. Amdahl's law is also the
`explorer` widget's example.

## Build plan

- Locally (before the join): build `hpc_scaling.pdf` in a studio course on `wrangler dev` with a real key to test
  A7. Results go in `notes-A.md`.
- Live (J8, after the join): create the studio course on the live site, upload the PDF(s), build, review, publish.
  Pre-build it so the video never waits on a build. Keep the old Parallel Computing course private as a fallback.

## Pilot (J10)

To be filled in at J10: n, what people did, `coachInsights` and "My progress" numbers, one sentence each.
