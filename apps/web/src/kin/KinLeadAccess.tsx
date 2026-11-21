/** A section of an agent's page: a small title, an optional action beside it, then its body. */
export function KinAgentSection(props: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}
