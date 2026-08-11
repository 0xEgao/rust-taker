import type { ReactNode } from "react";
import { Background, Shell } from "../ui/layout";

/**
 * Full-screen frame for every onboarding route, so the role hub, the taker wizard, and the
 * maker intro share one visual language instead of each inventing a container.
 */
export function OnboardingShell({
  title,
  status,
  children,
  wide = false,
}: {
  title: string;
  status: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
      <Background />
      <div className={`relative w-full ${wide ? "max-w-4xl" : "max-w-2xl"}`}>
        <Shell title={title} status={status}>
          {children}
        </Shell>
      </div>
    </div>
  );
}
