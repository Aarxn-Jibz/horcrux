import type { DisplayError } from "../lib/errors";

export function OperationError({ error }: { error: DisplayError }) {
  return (
    <div className="error" role="alert">
      <span>{error.message}</span>
      {error.detail && <details><summary>Technical details</summary><code>{error.detail}</code></details>}
    </div>
  );
}
