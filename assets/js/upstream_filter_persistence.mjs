const FILTER_KEYS = ["query", "pool_id", "status", "quota", "sort"];
export const UPSTREAM_FILTER_STORAGE_KEY = "codex-pooler:upstreams:filters:v1";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

export const filtersFromSearch = (search) => {
	const params = new URLSearchParams(search || "");

	return Object.fromEntries(
		FILTER_KEYS.flatMap((key) => {
			const value = params.get(key);
			return value ? [[key, value]] : [];
		}),
	);
};

export const loadStoredFilters = (storage) => {
	try {
		const filters = JSON.parse(storage?.getItem(UPSTREAM_FILTER_STORAGE_KEY) || "{}");
		if (!isRecord(filters)) return {};

		return Object.fromEntries(
			FILTER_KEYS.flatMap((key) =>
				typeof filters[key] === "string" && filters[key] !== ""
					? [[key, filters[key]]]
					: [],
			),
		);
	} catch (_error) {
		return {};
	}
};

export const storeFilters = (storage, search) => {
	try {
		storage?.setItem(
			UPSTREAM_FILTER_STORAGE_KEY,
			JSON.stringify(filtersFromSearch(search)),
		);
	} catch (_error) {
		// Storage can be disabled; filters still work through the URL.
	}
};

export const createUpstreamFilterPersistenceHook = (windowRef = globalThis) => ({
	mounted() {
		const currentFilters = filtersFromSearch(windowRef.location.search);
		const savedFilters = loadStoredFilters(windowRef.localStorage);

		this.persistFilters = () => storeFilters(windowRef.localStorage, windowRef.location.search);
		windowRef.addEventListener("phx:page-loading-stop", this.persistFilters);

		if (Object.keys(currentFilters).length === 0 && Object.keys(savedFilters).length > 0) {
			this.pushEvent("restore_upstream_filters", savedFilters);
			return;
		}

		this.persistFilters();
	},
	destroyed() {
		windowRef.removeEventListener("phx:page-loading-stop", this.persistFilters);
	},
});

export const UpstreamFilterPersistence = createUpstreamFilterPersistenceHook();
