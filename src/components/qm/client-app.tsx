"use client";
// The app reads per-viewer preferences from localStorage, so it renders on the client only.
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const QueueMindApp = dynamic(() => import("./app").then((m) => m.QueueMindApp), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-screen place-items-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  ),
});

export function ClientApp() {
  return <QueueMindApp />;
}
