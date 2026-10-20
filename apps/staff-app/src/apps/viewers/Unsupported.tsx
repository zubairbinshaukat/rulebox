import { OpenWith } from "./OpenWith";
import { ViewerMessage } from "./ViewerMessage";
import { fileNameOf } from "./kind";

/** A file nothing here can show. It is allowed, so the person may still send it to an approved app. */
export default function Unsupported({ path }: { path: string }) {
  return (
    <ViewerMessage title="Preview not available." detail={fileNameOf(path)}>
      <OpenWith path={path} />
    </ViewerMessage>
  );
}
