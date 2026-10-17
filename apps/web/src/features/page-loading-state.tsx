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
			<div className="state-card" aria-live="polite" role="status">
				<span className="loading-spinner" aria-hidden="true" />
				<span>{message}</span>
			</div>
		</section>
	);
}
