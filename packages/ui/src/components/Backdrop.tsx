/** The two blurred colour blobs behind the desktop. Hidden in Lite mode via CSS. */
export function Backdrop() {
  return (
    <div className="rb-backdrop" aria-hidden="true">
      <div className="rb-backdrop__blob rb-backdrop__blob--a" />
      <div className="rb-backdrop__blob rb-backdrop__blob--b" />
    </div>
  );
}