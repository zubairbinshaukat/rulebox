import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as SVG `<rect>` elements from `uqr`'s module matrix
 * (Step 4 #5). Nothing is fetched; nothing touches a canvas.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, cells } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    const out: { x: number; y: number }[] = [];
    qr.data.forEach((row, y) => row.forEach((on, x) => on && out.push({ x, y })));
    return { size: qr.size, cells: out };
  }, [value]);
  return (
    <svg className="dash-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1} height={1} />
      ))}
    </svg>
  );
}
