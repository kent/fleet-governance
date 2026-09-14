"use client";

import { useState } from "react";

/** Keep large fleets inspectable without mounting thousands of panels or ballot reasons. */
export function useCollectionPage<T>(items: readonly T[], label: string, searchableText: (item: T) => string) {
  const [query, setQuery] = useState("");
  const [requestedPage, setPage] = useState(0);
  const pageSize = 50;
  const needle = query.trim().toLowerCase();
  const filtered = needle ? items.filter(item => searchableText(item).toLowerCase().includes(needle)) : items;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const controls = items.length > pageSize || query ? <nav aria-label={`${label} pages`}>
    <label>Search {label} <input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
    <p>{filtered.length} of {items.length} {label}. Page {page + 1} of {pages}.</p>
    <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>{" "}
    <button type="button" disabled={page + 1 === pages} onClick={() => setPage(page + 1)}>Next</button>
  </nav> : null;
  return { visible: filtered.slice(page * pageSize, (page + 1) * pageSize), controls };
}
