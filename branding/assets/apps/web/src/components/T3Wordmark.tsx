import type { SVGProps } from "react";

// Kin's wordmark until a drawn one replaces it; the name keeps upstream's imports working.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 112 56" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="54"
        fontSize="74"
        fontWeight="700"
        fill="currentColor"
        textLength="112"
        lengthAdjust="spacingAndGlyphs"
      >
        Kin
      </text>
    </svg>
  );
}
