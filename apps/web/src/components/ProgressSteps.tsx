import type { PipelineStage } from "@horcrux-file-system/core";

type DisplayStage = { label: string; stages: Array<PipelineStage | "saving"> };

const uploadStages: DisplayStage[] = [
  { label: "Preparing", stages: ["preparing"] },
  { label: "Securing", stages: ["compressing", "encrypting", "encoding", "splitting-key"] },
  { label: "Distributing", stages: ["distributing"] },
  { label: "Finalizing", stages: ["saving"] },
  { label: "Ready", stages: ["complete"] },
];

const downloadStages: DisplayStage[] = [
  { label: "Locating", stages: ["locating"] },
  { label: "Retrieving", stages: ["retrieving"] },
  { label: "Reconstructing", stages: ["reconstructing"] },
  { label: "Decrypting", stages: ["decrypting"] },
  { label: "Verifying", stages: ["decompressing", "verifying"] },
  { label: "Ready", stages: ["complete"] },
];

export function ProgressSteps({ current, flow = "upload" }: { current: PipelineStage | "saving"; flow?: "upload" | "download" }) {
  const steps = flow === "upload" ? uploadStages : downloadStages;
  const active = steps.findIndex((step) => step.stages.includes(current));
  return (
    <ol className={`progress-steps progress-${flow}`} aria-label={`${flow} progress`}>
      {steps.map((step, index) => (
        <li className={index < active ? "done" : index === active ? "active" : ""} key={step.label} aria-current={index === active ? "step" : undefined}>
          <span>{index < active ? "✓" : index + 1}</span>{step.label}
        </li>
      ))}
    </ol>
  );
}
