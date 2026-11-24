# Translation statistics

Open **Settings → Translation statistics** to see request volume, speed, and failures. Use these records to choose services and adjust request frequency.

<GuideVisual kind="stats" en />

## Start with the overview

Choose today, 7 days, or 30 days, then filter by service or model.

| Metric | Meaning |
| --- | --- |
| Translation requests | Count and success rate; errors and timeouts are separate, and cancellation after leaving a page is not a failure |
| Text translated | Source characters, segments, and data size in requests |
| Average duration | Time from requesting to receiving a result, with P95, longest duration, and service waiting time |
| Cache reuse | Share of segments returned from existing translations without another service call |

The trend chart switches between request count, average duration, and text volume.

## Compare services

In **Service performance**, select a column header to sort or a service row to filter its records. Select the row again to clear the filter. Durations cover successful calls to services and exclude results returned directly from cache.

**P95** estimates the time within which about 95% of requests finish. Larger batches usually take longer; use each row’s characters-per-second figure to help compare services.

For free translation, select the free service and inspect **Free translation routes**. A request may try another route after a failure, so attempts can outnumber requests. Route durations count successful attempts only. Adjust enabled routes and their order under **Translation services → Free translation**.

## Find slow requests and failures

Duration and size distributions show whether a few long requests or a wider slowdown caused the delay. Failure groups distinguish key or permission issues, rate or quota limits, timeouts, and network problems. For frequent rate limits, lower concurrency or requests per second in **Advanced**.

**Request history** shows time, service and model, size, status, and duration. Filter by status or sort by **Slowest** to find unusual requests.

| Source | Meaning |
| --- | --- |
| Service | Text was sent to a translation service |
| Cache hit | All segments used existing translations |
| Partly cached | Some segments used cache; the rest called a service |
| Merged | Shared an identical request already in progress |

## Storage and clearing

Statistics stay in this browser: the latest 5,000 requests and 90 days of hourly summaries are retained. **Clear statistics** leaves the translation cache, model usage, and settings intact.

For AI token usage, see [AI usage](/en/guide/model-usage).

## Related guides

- [Translation services](/en/config/translation-engines)
- [Troubleshooting](/en/guide/faq)
