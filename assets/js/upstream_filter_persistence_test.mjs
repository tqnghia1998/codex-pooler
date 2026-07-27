import assert from "node:assert/strict";
import test from "node:test";

import {
	UPSTREAM_FILTER_STORAGE_KEY,
	filtersFromSearch,
	loadStoredFilters,
	storeFilters,
} from "./upstream_filter_persistence.mjs";

const storage = () => {
	const values = new Map();
	return {
		getItem: (key) => values.get(key) || null,
		setItem: (key, value) => values.set(key, value),
	};
};

test("keeps only upstream filter params", () => {
	assert.deepEqual(
		filtersFromSearch("?query=compass&pool_id=pool-1&status=active&ignored=yes"),
		{ query: "compass", pool_id: "pool-1", status: "active" },
	);
});

test("stores filters from the URL and ignores corrupt saved data", () => {
	const localStorage = storage();
	storeFilters(localStorage, "?quota=low&sort=name");

	assert.equal(
		localStorage.getItem(UPSTREAM_FILTER_STORAGE_KEY),
		'{"quota":"low","sort":"name"}',
	);
	assert.deepEqual(loadStoredFilters(localStorage), { quota: "low", sort: "name" });

	localStorage.setItem(UPSTREAM_FILTER_STORAGE_KEY, "not-json");
	assert.deepEqual(loadStoredFilters(localStorage), {});
});
