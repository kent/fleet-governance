import RunView from "../../../components/RunView.js";

/** `/runs/[id]` (spec 12.3): the live run view. Server component just unwraps the dynamic route
 *  param and hands off to the client component that fetches state and subscribes to events. */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView runId={id} />;
}
