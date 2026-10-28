/** Public addresses are synthetic policy inputs; tests never contact them. */
export function nativeEgressFixture() {
	return {
		destinations: [{ destination: { ip: "8.8.8.8" }, port: 443 }] as [
			{ destination: { ip: string }; port: number },
		],
		protectedNetworks: {
			platformDatabase: ["10.0.0.0/24"],
			connectionDatabase: ["10.1.0.0/24"],
			kubernetesApi: ["9.9.9.9"],
			sandboxPodNetworks: ["10.2.0.0/16"],
		},
	};
}
