export function PageLoadingState({
	title,
	message,
}: {
	title: string;
	message: string;
}) {
	return (
		<section aria-label={title}>
			<header className="page-heading">
				<div>
					<h1>{title}</h1>
				</div>
			</header>
			<p aria-live="polite" className="text-muted-foreground" role="status">
				{message}
			</p>
		</section>
	);
}
