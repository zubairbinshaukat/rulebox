import { useEffect, useState } from "react";
import { Button } from "@rulebox/ui";

import { fileErrorText } from "../files/errors";
import { call } from "../../lib/tauri";

/**
 * "Open with <app>", shown only when the policy names an app for this kind of
 * file (`fileHandlers`). It asks the backend, which starts the approved app
 * with the file; the page never sees a program path.
 */
export function OpenWith({ path }: { path: string }) {
  const [app, setApp] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void call("fs_handler", { path }).then(
      (name) => {
        if (current) setApp(name);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [path]);

  if (!app) {
    return null;
  }

  async function run() {
    setProblem(null);
    try {
      const action = await call("fs_open_with", { path });
      if (action.action === "blocked") {
        setProblem("This type of file can't be opened on this PC.");
      } else if (action.action === "noHandler") {
        setProblem("No app on this PC can open this file.");
      }
    } catch (error) {
      setProblem(fileErrorText(error));
    }
  }

  return (
    <>
      <Button type="button" onClick={() => void run()}>
        Open with {app}
      </Button>
      {problem ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--rb-danger-text)" }}>
          {problem}
        </p>
      ) : null}
    </>
  );
}
