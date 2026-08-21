# ECharts interaction research: legend toggling, dataZoom, multi-chart linking

Scope: verified against the Apache ECharts **option reference**, **API reference**, **handbook**, and the `apache/echarts` source at commit `30076ae` (version `6.1.0`, per [package.json](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/package.json)). Where the published docs are silent or ambiguous (notably the `datazoom` payload shape and the `connect` propagation set), the claim is backed by a source permalink.

Note on citation form: `echarts.apache.org/en/option.html` and `api.html` are client-rendered single pages, so the anchor links below are the canonical human URLs; the corresponding machine-readable doc source lives in [`apache/echarts-doc`](https://github.com/apache/echarts-doc) and is cited alongside where the exact wording matters.

## 1. Legend toggling

**Clicking a legend item toggles its series' visibility with zero custom code.** The legend component reference states it directly: "Legend component shows symbol, color and name of different series. You can click legends to toggle displaying series in the chart." ([legend, option reference](https://echarts.apache.org/en/option.html#legend); [doc source](https://github.com/apache/echarts-doc/blob/master/en/option/component/legend.md)). Including `legend: {}` in the option is sufficient — no handler is required.

**`legend.selectedMode`** (type `string | boolean`, default `true`) is the switch: "Selected mode of legend, which controls whether series can be toggled displaying by clicking legends. It is enabled by default, and you may set it to be `false` to disable it." and "Besides, it can be set to `'single'` or `'multiple'`, for single selection and multiple selection." ([legend.selectedMode](https://echarts.apache.org/en/option.html#legend.selectedMode); [doc source, lines 133-139](https://github.com/apache/echarts-doc/blob/master/en/option/component/legend.md)). So: `true` (default) and `'multiple'` allow any combination of series on/off; `'single'` makes the legend behave like radio buttons (exactly one series visible); `false` renders the legend as a non-interactive key.

**Which series start hidden — `legend.selected`.** It is an object "State table of selected legend", keyed by series/legend-item name, with `true` = shown and `false` = hidden ([legend.selected](https://echarts.apache.org/en/option.html#legend.selected); [doc source, lines 157-169](https://github.com/apache/echarts-doc/blob/master/en/option/component/legend.md)). Names must match the `legend.data` matching rules, which fall back to `series.name` ([legend.data](https://echarts.apache.org/en/option.html#legend.data)).

```ts
import type { EChartsOption } from 'echarts';

const option: EChartsOption = {
  legend: {
    selectedMode: 'multiple', // default `true` behaves the same; 'single' = radio; false = disabled
    selected: {
      Actual: true,
      Forecast: false, // Forecast starts hidden; user can click it on
    },
  },
  series: [
    { name: 'Actual', type: 'line', data: [] },
    { name: 'Forecast', type: 'line', data: [] },
  ],
};
```

**Event emitted on legend click: `legendselectchanged`.** The events reference is explicit that this — not `legendselected` — is the one fired by user interaction: "Event emitted after legend selecting state changes. **Attention:** This event will be emitted when users toggle legend button in legend component." ([events.legendselectchanged](https://echarts.apache.org/en/api.html#events.legendselectchanged); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/events.md)). The handbook repeats the caveat: `'legendselectchanged'` is "triggered while changing the legend selected (please notice that `legendselected` won't be triggered in this situation)" ([handbook, events](https://echarts.apache.org/handbook/en/concepts/event)).

Payload shape, verbatim from the reference ([events.legendselectchanged](https://echarts.apache.org/en/api.html#events.legendselectchanged)):

```ts
{
  type: 'legendselectchanged',
  name: string,                          // the legend item just clicked
  selected: { [name: string]: boolean }  // table of ALL legend selecting states
}
```

The `selected` table carries the full current state, so a handler never needs to track state itself:

```ts
type LegendSelectChanged = {
  type: 'legendselectchanged';
  name: string;
  selected: Record<string, boolean>;
};

chart.on('legendselectchanged', (params) => {
  const p = params as unknown as LegendSelectChanged;
  const visible = Object.entries(p.selected)
    .filter(([, on]) => on)
    .map(([name]) => name);
  console.log(`clicked ${p.name}; now visible:`, visible);
});
```

**Imperative toggling from code — `dispatchAction`.** Three legend actions exist, each paired with the event it emits ([action.legend](https://echarts.apache.org/en/api.html#action.legend); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/action.md)):

| Action | Docs say | Emits |
| --- | --- | --- |
| `legendToggleSelect` | "Toggles legend selecting state." | `legendselectchanged` ([ref](https://echarts.apache.org/en/api.html#action.legend.legendToggleSelect)) |
| `legendSelect` | "Selects the legend." | `legendselected` ([ref](https://echarts.apache.org/en/api.html#action.legend.legendSelect)) |
| `legendUnSelect` | "Unselects the legend." | `legendunselected` ([ref](https://echarts.apache.org/en/api.html#action.legend.legendUnSelect)) |

All three take just `{ type, name }` ([action.legend.legendToggleSelect](https://echarts.apache.org/en/api.html#action.legend.legendToggleSelect)), and the source confirms the action→event registration pairs ([`legendAction.ts` L95-137](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/legend/legendAction.ts#L95-L137)):

```ts
chart.dispatchAction({ type: 'legendToggleSelect', name: 'Forecast' }); // flip
chart.dispatchAction({ type: 'legendUnSelect', name: 'Forecast' });     // force hidden
chart.dispatchAction({ type: 'legendSelect', name: 'Forecast' });       // force shown
```

`legendAllSelect` and `legendInverseSelect` also exist for select-all / invert ([action.legend.legendAllSelect](https://echarts.apache.org/en/api.html#action.legend.legendAllSelect)); since v5.6.0 `legendAllSelect` accepts `legendId` / `legendIndex` to target one of several legend components ([doc source](https://github.com/apache/echarts-doc/blob/master/en/api/action.md)).

## 2. dataZoom range selection

**Range selection works out of the box.** The component reference: "`dataZoom` component is used for zooming a specific area, which enables user to investigate data in detail, or get an overview of the data, or get rid of outlier points." ([dataZoom](https://echarts.apache.org/en/option.html#dataZoom); [doc source](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)). Adding a `dataZoom` entry to the option is all that is required; no handler is needed for the zoom itself to take effect.

### The two types

**`type: 'slider'`** — "Slider type dataZoom component provides functions like data thumbnail, zoom, brush to select, drag to move, click to locate." ([dataZoom-slider](https://echarts.apache.org/en/option.html#dataZoom-slider); [doc source](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom-slider.md)). Drag-to-brush a range on the slider is on by default: `brushSelect` defaults to `true` (since v5.0.0) ([dataZoom-slider.brushSelect](https://echarts.apache.org/en/option.html#dataZoom-slider.brushSelect)). `realtime` defaults to `true` — "Whether to update view while dragging. If it is set as `false`, the view will be updated only at the end of dragging." ([dataZoom-slider.realtime](https://echarts.apache.org/en/option.html#dataZoom-slider.realtime)). `show: false` is legal and notable: "If is set to be `false`, it will not show, but its data filtering function still works" ([dataZoom-slider.show](https://echarts.apache.org/en/option.html#dataZoom-slider.show)) — useful for a headless range holder driven only by code.

**`type: 'inside'`** — "Data zoom component of *inside* type. […] The *inside* means it's inside the coordinates." with translation by dragging in the coordinate area and scaling by mouse wheel on PC / two-finger touch on mobile ([dataZoom-inside](https://echarts.apache.org/en/option.html#dataZoom-inside); [doc source](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom-inside.md)). Its interaction triggers are individually configurable: `zoomOnMouseWheel` (default `true`), `moveOnMouseMove` (default `true`), `moveOnMouseWheel` (default `false`), each accepting `true | false | 'shift' | 'ctrl' | 'alt'` ([dataZoom-inside.zoomOnMouseWheel](https://echarts.apache.org/en/option.html#dataZoom-inside.zoomOnMouseWheel)). Setting `zoomOnMouseWheel: 'ctrl'` is the usual fix for a chart that hijacks page scrolling.

### Both together — yes, and they auto-sync

Using a slider plus an inside zoom on the same axis is explicitly supported, and they stay in step without any code: "A single chart instance can contain several `dataZoom` components, each of which controls different axes. The `dataZoom` components that control the same axis will be automatically linked (i.e., all of them will be updated when one of them is updated by user action or API call)." ([dataZoom](https://echarts.apache.org/en/option.html#dataZoom); [doc source, line 31](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)). This is the standard pattern: wheel/drag inside the plot **and** a visible slider, both showing one shared range.

```ts
const option: EChartsOption = {
  dataZoom: [
    { type: 'slider', xAxisIndex: [0], filterMode: 'filter', start: 0, end: 100 },
    { type: 'inside', xAxisIndex: [0], filterMode: 'filter', zoomOnMouseWheel: 'ctrl' },
  ],
};
```

### Which axes it drives — `xAxisIndex`

"Use `dataZoom.xAxisIndex` or `dataZoom.yAxisIndex` or `dataZoom.radiusAxisIndex` or `dataZoom.angleAxisIndex` to specify which axes are operated by `dataZoom`." ([dataZoom.xAxisIndex](https://echarts.apache.org/en/option.html#dataZoom.xAxisIndex); [doc source, line 29](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)). It accepts a number or an array of indices, so one dataZoom can drive several x-axes in the same instance ([dataZoom-slider.xAxisIndex](https://echarts.apache.org/en/option.html#dataZoom-slider.xAxisIndex)).

### Window: percentages vs data values

Two mutually exclusive forms ([dataZoom, "How to set window"](https://echarts.apache.org/en/option.html#dataZoom); [doc source, lines 48-54](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)):

| Form | Options | Docs |
| --- | --- | --- |
| Percent | `start` (default `0`), `end` (default `100`) — "The start percentage of the window out of the data extent, in the range of 0 ~ 100." | [start](https://echarts.apache.org/en/option.html#dataZoom.start) / [end](https://echarts.apache.org/en/option.html#dataZoom.end) |
| Absolute | `startValue`, `endValue` (`number\|string\|Date`, default `null`) — "define the window of the data window in **absolute value** form." | [startValue](https://echarts.apache.org/en/option.html#dataZoom.startValue) / [endValue](https://echarts.apache.org/en/option.html#dataZoom.endValue) |

**Precedence matters:** `startValue` "not works when `dataZoom.start` is set", and `endValue` "doesn't work when `dataZoom.end` is set" ([dataZoom.startValue](https://echarts.apache.org/en/option.html#dataZoom.startValue), [dataZoom.endValue](https://echarts.apache.org/en/option.html#dataZoom.endValue)). Since `start`/`end` have *defaults* of `0`/`100`, when you want an absolute window you must set `startValue`/`endValue` and leave `start`/`end` out of the object you dispatch — otherwise the percentages win. For a monthly-time-series dashboard, `startValue`/`endValue` as timestamps or `Date`s is the more meaningful currency, because a percentage means different calendar dates on two series of different lengths.

For a `category` axis: "if an axis is set to be `category`, `startValue` could be set as `index` of the array of `axis.data` or as the array value itself. In the latter case, it will internally and automatically translate to the index of array." ([dataZoom.startValue](https://echarts.apache.org/en/option.html#dataZoom.startValue)).

Caveat when using percentages with two dataZooms: "If use percent value form, and it is in the scenario below, the result of dataZoom depends on the sequence of dataZoom definitions appearing in `option`." ([doc source, line 56](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)) — another argument for `startValue`/`endValue`.

### `filterMode` — this is the forecast-vs-actual knob

Four values ([dataZoom.filterMode](https://echarts.apache.org/en/option.html#dataZoom.filterMode); [doc source, lines 327-351](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)), quoted:

| Value | Behaviour | Effect on the *other* axis |
| --- | --- | --- |
| `'filter'` (default for slider/inside) | "data that outside the window will be **filtered out**, which may lead to some changes of windows of other axes. For each data item, it will be filtered out if one of the relevant dimensions is out of the window." | y-axis **rescales** to the visible subset |
| `'weakFilter'` | "data that outside the window will be **filtered out** […] For each data item, it will be filtered out only if all of the relevant dimensions are out of the same side of the window." | y-axis rescales; kinder to interval/range data |
| `'empty'` | "data that outside the window will be **set to NaN**, which will not lead to changes of windows of other axes." | y-axis **stays fixed** |
| `'none'` | "Do not filter data." | no rescaling |

The docs' own guidance: "If only `xAxis` or only `yAxis` is controlled by `dataZoom`, `filterMode: 'filter'` is typically used, which enable the other axis auto adapte its window to the extent of the filtered data." ([doc source, line 345](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)).

**Why this matters for comparing forecast vs actual.** With the default `'filter'`, zooming the x-axis makes the y-axis re-fit the visible rows, so the *same* forecast line changes apparent slope and magnitude as you pan — two charts zoomed to the same range but holding different series will end up with **different y-scales**, which defeats visual comparison. Two documented remedies:

1. `filterMode: 'empty'` — out-of-window points become `NaN` and the y-window is left alone, so the y-scale is stable across zooms ([doc source, line 339](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)).
2. Pin the axis explicitly: "when `min`, `max` of an axis is set (e.g., `yAxis: {min: 0, max: 400}`), this extent of the axis will not be modified by the behaviour of dataZoom of other axis any more." ([doc source, line 42](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)).

For a cashflow dashboard where charts must be read against each other, prefer `'filter'` for the ergonomic auto-fit **or** `'empty'` + shared `yAxis.min/max` when cross-chart magnitude comparison is the point. Note `'filter'` genuinely removes rows from downstream computation, which also affects any `min`/`max`/average labels.

## 3. Reacting to a dataZoom event

**The event is `datazoom`** — all lowercase, as with every ECharts action event ("Event type should be all lowercase", [`echarts.ts` L3148-3151](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L3148-L3151)). It is "Event emitted after zooming data area." and is paired with the `dataZoom` action ([events.datazoom](https://echarts.apache.org/en/api.html#events.datazoom); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/events.md)).

### What the docs promise

```ts
{
  type: 'datazoom',
  // percentage of zoom start position, 0 - 100
  start: number,
  // percentage of zoom finish position, 0 - 100
  end: number,
  // data value of zoom start position; only exists in zoom event of triggered by toolbar
  startValue?: number,
  // data value of zoom finish position; only exists in zoom event of triggered by toolbar
  endValue?: number
}
```

([events.datazoom](https://echarts.apache.org/en/api.html#events.datazoom)). Note the documented restriction already visible here: `startValue`/`endValue` "only exists in zoom event of triggered by toolbar" — i.e. **do not rely on absolute values being in the payload** for slider or inside interaction.

### What actually arrives — the wrinkle, from source

The published payload is incomplete, and the shape differs by interaction type. Verified in the v6.1.0 source:

**Slider drag** dispatches a *flat* payload carrying `start`/`end` percentages plus `from` and `dataZoomId`, and no absolute values ([`SliderZoomView.ts` L1091-1102](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/SliderZoomView.ts#L1091-L1102)):

```ts
this.api.dispatchAction({
    type: 'dataZoom',
    from: this.uid,
    dataZoomId: this.dataZoomModel.id,
    animation: realtime ? REALTIME_ANIMATION_CONFIG : null,
    start: range[0],
    end: range[1]
});
```

**Inside (pan / wheel-zoom / scrollMove)** dispatches a **`batch`** array instead — one item per affected dataZoom component, each with `dataZoomId`, `start`, `end`; the top level has *no* `start`/`end` at all ([`roams.ts` L124-168](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/roams.ts#L124-L168)):

```ts
api.dispatchAction({
    type: 'dataZoom',
    animation: { easing: 'cubicOut', duration: 100 },
    batch: batch          // [{ dataZoomId, start, end }, ...]
});
```

The toolbox zoom likewise dispatches a `batch`, but its items *do* carry `startValue`/`endValue` ([`toolbox/feature/DataZoom.ts` L184-213](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/toolbox/feature/DataZoom.ts#L184-L213)) — which is exactly why the docs say absolute values appear only for toolbar-triggered zooms.

Crucially, a batched *action* produces a batched *event*: when `payload.batch` is present, the emitted event object is rebuilt as `{ type, escapeConnect, batch: eventObjBatch }` — the per-item fields live under `batch`, not at the top level ([`echarts.ts` L2234-2245](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L2234-L2245)). `batch?: ECEventData[]` is part of the declared event type ([`util/types.ts` L240-250](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/util/types.ts#L240-L250)). `dispatchAction`'s own docs confirm the mechanism: "`payload` parameter can trigger multiple actions through `batch` attribute." ([echartsInstance.dispatchAction](https://echarts.apache.org/en/api.html#echartsInstance.dispatchAction)).

Summary of what to expect:

| Trigger | `start`/`end` at top level | `startValue`/`endValue` | `batch` |
| --- | --- | --- | --- |
| Slider drag/brush | yes | no | no |
| Inside pan/wheel | **no** | no | **yes** |
| Toolbox dataZoom | no | yes (inside `batch`) | yes |
| `dispatchAction` you make | whatever you sent | whatever you sent | if you sent one |

### The reliable read: `chart.getOption().dataZoom[0]`

The documented fallback is to ignore the payload's values and ask the instance. `getOption` "Gets `option` object maintained in current instance, which contains configuration item and data merged from previous `setOption` operations by users, **along with user interaction states. For example, switching of legend, zooming area of data zoom**, and so on." ([echartsInstance.getOption](https://echarts.apache.org/en/api.html#echartsInstance.getOption); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/echarts-instance.md)). Also documented there: "Attribute values in each component of the returned option are all in the form of an array, no matter it's single object or array of object when passed by `setOption`" — hence `dataZoom[0]`, always indexed.

Better still, the internal processor deliberately back-fills **all four** range props for exactly this purpose, with the comment "Fullfill all of the range props so that user is able to get them from chart.getOption()" ([`dataZoomProcessor.ts` L121-135](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/dataZoomProcessor.ts#L121-L135)):

```ts
dataZoomModel.setCalculatedRange({
    start: percent[0], end: percent[1],
    startValue: value[0], endValue: value[1]
});
```

So `getOption().dataZoom[0]` yields `start`, `end`, `startValue` **and** `endValue` after any zoom — including inside-pan, where the event payload carries none of them. This makes `getOption()` the only shape-independent way to obtain an absolute date range.

### Working sample

```ts
import * as echarts from 'echarts';

type DataZoomRange = { start: number; end: number; startValue?: number; endValue?: number };

type DataZoomEventPayload = {
  type: 'datazoom';
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  dataZoomId?: string;
  batch?: Array<{ dataZoomId?: string; start?: number; end?: number; startValue?: number; endValue?: number }>;
};

/**
 * Shape-independent range read. Prefers the instance's own option, which the
 * dataZoomProcessor back-fills with all four range props after every zoom;
 * falls back to the payload for the flat slider case.
 */
function readRange(chart: echarts.ECharts, payload?: DataZoomEventPayload, index = 0): DataZoomRange | null {
  const opt = chart.getOption() as { dataZoom?: DataZoomRange[] };
  const dz = opt.dataZoom?.[index];
  if (dz && dz.start != null && dz.end != null) {
    return { start: dz.start, end: dz.end, startValue: dz.startValue, endValue: dz.endValue };
  }
  // Fallback: flat slider payload, or first batch item for inside/toolbox.
  const p = payload?.batch?.[0] ?? payload;
  if (p && p.start != null && p.end != null) {
    return { start: p.start, end: p.end, startValue: p.startValue, endValue: p.endValue };
  }
  return null;
}

chart.on('datazoom', (params) => {
  const payload = params as unknown as DataZoomEventPayload;
  const range = readRange(chart, payload);
  if (!range) return;

  // startValue/endValue are timestamps when the xAxis is type: 'time'
  const from = range.startValue != null ? new Date(range.startValue) : null;
  const to = range.endValue != null ? new Date(range.endValue) : null;
  console.log(`${range.start.toFixed(1)}%–${range.end.toFixed(1)}%`, from, to);
});
```

Two practical notes. The slider throttles its dispatch via `dataZoom.throttle` ([`SliderZoomView.ts` L160-165](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/SliderZoomView.ts#L160-L165)), so with `realtime: true` the handler fires repeatedly during a drag — debounce anything expensive, or set `realtime: false` so the view (and event) settles only at drag end ([dataZoom-slider.realtime](https://echarts.apache.org/en/option.html#dataZoom-slider.realtime)). And `chart.on` accepts an optional query argument to narrow which component's events you receive ([echartsInstance.on](https://echarts.apache.org/en/api.html#echartsInstance.on)).

## 4. Linking multiple charts to one range

### (a) `echarts.connect` group linking

The API: "Connects interaction of multiple chart series." Its parameter is a "Group id, or array of chart instance", and the two documented forms are ([echarts.connect](https://echarts.apache.org/en/api.html#echarts.connect); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/echarts.md)):

```ts
// set group id of each instance respectively
chart1.group = 'group1';
chart2.group = 'group1';
echarts.connect('group1');
// or pass the instance array directly
echarts.connect([chart1, chart2]);
```

`echarts.disconnect(groupId)` reverses it, and "To have one single instance to be removed, you can set `group` of chart instance to be null." ([echarts.disconnect](https://echarts.apache.org/en/api.html#echarts.disconnect)).

**Exactly which actions does it propagate?** The published docs do not say — "interaction of multiple chart series" is all the reference offers. The source answers precisely. `connect` installs one listener per entry in `connectionEventRevertMap`, converts the received event back into its originating action via `makeActionFromEvent`, and dispatches that action to every other chart in the group ([`echarts.ts` L2806-2841](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L2806-L2841)):

```ts
each(connectionEventRevertMap, function (_, eventType) {
    chart._messageCenter.on(eventType, function (event) {
        if (connectedGroups[chart.group] && chart[CONNECT_STATUS_KEY] !== CONNECT_STATUS_PENDING) {
            if (event && event.escapeConnect) { return; }
            const action = chart.makeActionFromEvent(event);
            // ... dispatch to every other chart with the same group
        }
    });
});
```

And `connectionEventRevertMap` is populated for **every** action registered anywhere in the library — the last line of `registerAction` is `connectionEventRevertMap[nonRefinedEventType] = actionType;` ([`echarts.ts` L3183-3187](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L3183-L3187)). So the propagation set is "all registered actions", not a curated list:

| Interaction | Propagated by `connect`? | Evidence |
| --- | --- | --- |
| **dataZoom** | **Yes** — `dataZoom` is a registered action emitting `datazoom` | [`dataZoomAction.ts` L27](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/dataZoomAction.ts#L27) |
| **Legend toggling** | **Yes** — `legendToggleSelect` → `legendselectchanged` is registered | [`legendAction.ts` L102-137](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/legend/legendAction.ts#L102-L137) |
| **Tooltip (`showTip`/`hideTip`)** | Registered, so in principle yes — **but** the tooltip/axisPointer machinery marks its own dispatches `escapeConnect: true`, which the guard above drops | actions: [`tooltip/install.ts` L39-55](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/tooltip/install.ts#L39-L55); guard: [`axisTrigger.ts` L436-440](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/axisPointer/axisTrigger.ts#L436-L440) |
| Highlight / downplay | Registered, but axisPointer-driven ones set `escapeConnect: true` | [`axisTrigger.ts` L491-503](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/axisPointer/axisTrigger.ts#L491-L503) |

Practical consequence: `connect` is **all-or-nothing**. You cannot ask it to share only the dataZoom range — turning it on also ties legend selection together across every chart in the group. For this dashboard that is likely wrong: a shared time range is desirable, but hiding "Forecast" on the income chart should not blank it on the balance chart. `connect` also affects `getConnectedDataURL` / group export and the `connectedBackgroundColor` option ([echarts.init opts](https://echarts.apache.org/en/api.html#echarts.init)).

### (b) Manual propagation — listen to `datazoom`, dispatch to siblings

Selective by construction: handle `datazoom` on the chart the user touched and call the `dataZoom` action on the others. The action accepts `dataZoomIndex`, `start`, `end`, `startValue`, `endValue` ([action.dataZoom.dataZoom](https://echarts.apache.org/en/api.html#action.dataZoom.dataZoom); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/action.md)):

```ts
chart.dispatchAction({ type: 'dataZoom', start: 20, end: 30 });
```

**Avoiding the infinite loop.** Dispatching `dataZoom` on a sibling causes that sibling to emit its own `datazoom` event, whose handler dispatches back — a ping-pong. There are two documented/idiomatic guards, and it is worth being clear that the *first* is the one ECharts itself uses:

1. **`silent` on `dispatchAction`** — the second parameter suppresses event emission. The signature is `dispatchAction(payload, opt?: boolean | { silent?: boolean, flush?: boolean })`, where "If pass boolean, means opt.silent" and `silent` means "Whether trigger events" ([`echarts.ts` L1567-1580](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L1567-L1580)). The same `silent` flag is documented on `setOption` and `resize` ([echartsInstance.resize](https://echarts.apache.org/en/api.html#echartsInstance.resize)). A silent dispatch updates the sibling's view without re-emitting `datazoom`, so the cycle cannot start.

2. **A re-entrancy flag** — mirroring ECharts' internal `escapeConnect` / `CONNECT_STATUS_PENDING` approach, where a propagated event is tagged so the receiving handler bails out (`if (event && event.escapeConnect) { return; }`, [`echarts.ts` L2815-2820](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L2815-L2820)). `escapeConnect` is a real field on the public `Payload` type ([`util/types.ts` L177-181](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/util/types.ts#L177-L181)) but it is only consulted by `connect`, so for hand-rolled propagation use your own boolean.

Belt-and-braces version using both:

```ts
import * as echarts from 'echarts';

let syncing = false;

function linkRanges(charts: echarts.ECharts[]): void {
  charts.forEach((source) => {
    source.on('datazoom', () => {
      if (syncing) return;             // guard 2: re-entrancy flag
      syncing = true;
      try {
        const range = readRange(source);   // from section 3
        if (!range) return;
        // Prefer absolute values so every chart lands on the same calendar range,
        // regardless of differing series lengths. Omit start/end: they take precedence.
        const payload =
          range.startValue != null && range.endValue != null
            ? { type: 'dataZoom' as const, startValue: range.startValue, endValue: range.endValue }
            : { type: 'dataZoom' as const, start: range.start, end: range.end };

        charts
          .filter((c) => c !== source)
          .forEach((target) => target.dispatchAction(payload, true)); // guard 1: silent
      } finally {
        syncing = false;
      }
    });
  });
}
```

Note the `startValue`/`endValue` preference: because "`startValue` […] not works when `dataZoom.start` is set" ([dataZoom.startValue](https://echarts.apache.org/en/option.html#dataZoom.startValue)), the two forms must not be mixed in one payload. And because a percentage maps to different dates on series of differing extents, absolute values are what actually keep several charts on the *same* time range. If a chart has multiple dataZoom components, target them with `dataZoomIndex` (or `dataZoomId`) — or rely on the auto-linking of same-axis components noted in section 2.

### (c) `axisPointer.link` — crosshair syncing only

"axisPointers can be linked to each other. The term 'link' represents that axes are synchronized and move together. Axes are linked according to the value of axisPointer." It takes an array of "link group" objects, and "Axes will be linked when they are referred in the same link group" ([axisPointer.link](https://echarts.apache.org/en/option.html#axisPointer.link); [doc source](https://github.com/apache/echarts-doc/blob/master/en/option/component/axisPointer.md)):

```ts
link: [
  { xAxisIndex: [0, 3, 4], yAxisName: 'someName' },
  { xAxisId: ['aa', 'cc'], angleAxis: 'all' },
]
```

Axes can be referenced by `someAxisIndex`, `someAxisName` or `someAxisId`, "can be an array or a value or `'all'`" ([axisPointer.link](https://echarts.apache.org/en/option.html#axisPointer.link)).

**Important limitation: this is within one chart instance, not across instances.** `axisPointer.link` is part of a single chart's option and links axes inside it (the canonical uses are multi-grid layouts). It also syncs only the *pointer/crosshair*, never the zoom window — it is complementary to, not a substitute for, (a) or (b). For a dashboard of separate `echarts.init` instances it does nothing across them; cross-instance crosshair requires `connect` (which shares `showTip`) or manual `showTip`/`hideTip` dispatching ([action.tooltip.showTip](https://echarts.apache.org/en/api.html#action.tooltip.showTip)).

### Recommendation for this dashboard

**Use (b), manual propagation, with a `silent` dispatch and a re-entrancy flag.**

Reasoning:

- **Selectivity is the deciding factor.** The requirement is "several charts follow the same selected time range" — the range only. `connect` propagates every registered action including `legendselectchanged` ([`echarts.ts` L3183-3187](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L3183-L3187)), so it would also gang the legends together, which is not wanted when each chart shows a different series set.
- **Absolute date ranges.** Manual dispatch lets you send `startValue`/`endValue` so all charts land on identical calendar bounds, avoiding the percentage-vs-extent mismatch the docs warn about ([dataZoom.startValue](https://echarts.apache.org/en/option.html#dataZoom.startValue)).
- **Small, cheap, and low-risk.** ~15 lines; with ~700 rows there is no performance concern, and the `silent` flag is a documented instance-API parameter rather than a hack ([`echarts.ts` L1567-1580](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L1567-L1580)).
- Add `axisPointer.link` **within** any chart that uses multiple grids, and consider `connect` only if you later decide you *want* legend + tooltip ganged as well.

If you would rather write no code at all and can accept shared legend state, `echarts.connect([...charts])` is the one-liner ([echarts.connect](https://echarts.apache.org/en/api.html#echarts.connect)) — see the flags section.

## 5. Vanilla-DOM / TypeScript practicalities

Nothing in the official story assumes a framework — the handbook's examples are plain `document.getElementById` + `echarts.init`, which is exactly this project's shape ([handbook, chart container and size](https://echarts.apache.org/handbook/en/concepts/chart-size)).

### Two documented import paths

The handbook frames the choice openly: "There are two approaches to using ECharts as a package. The simplest approach is to make all functionality immediately available by importing from `echarts`. However, it is encouraged to substantially decrease bundle size by only importing as necessary such as `echarts/core` and `echarts/charts`." ([handbook, using ECharts as an NPM package](https://echarts.apache.org/handbook/en/basics/import); [source](https://github.com/apache/echarts-handbook/blob/master/contents/en/basics/import.md)).

**Full import** — "To include all of ECharts, we simply need to import `echarts`." ([handbook](https://echarts.apache.org/handbook/en/basics/import)):

```ts
import * as echarts from 'echarts';
const chart = echarts.init(document.getElementById('main')!);
```

**Tree-shaking path** — "The above code will import all the charts and components in ECharts, but if you don't want to bring in all the components, you can use the tree-shakeable interface provided by ECharts to bundle the required components and get a minimal bundle." ([handbook](https://echarts.apache.org/handbook/en/basics/import)). What the docs claim for bundle size is qualitative — "substantially decrease bundle size", "a minimal bundle" — no percentage figure is published, so treat concrete numbers as unverified.

The registration call is `echarts.use([...])`, documented as "Use components. Used with the new tree-shaking API" (since v5.0.1) with the hard constraint "**NOTE: `echarts.use` must be used before `echarts.init`**" ([echarts.use](https://echarts.apache.org/en/api.html#echarts.use); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/echarts.md)).

A **renderer is mandatory** on this path: "in order to keep the size of the package to a minimum, ECharts does not provide any renderer in the tree-shakeable interface, so you need to choose to import `CanvasRenderer` or `SVGRenderer` as the renderer." ([handbook](https://echarts.apache.org/handbook/en/basics/import)). Confirmed in source: the full `echarts` entry point pre-registers `CanvasRenderer` and `DatasetComponent` "for compitatble reason", while `echarts/core` does not ([`src/echarts.ts` L20-28](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/echarts.ts#L20-L28)). Forgetting the renderer is the classic blank-chart symptom.

Everything this dashboard needs is available as a tree-shakeable module — `LineChart`/`BarChart` from `echarts/charts`, and `LegendComponent`, `DataZoomComponent`, `GridComponent`, `TooltipComponent` from `echarts/components` ([echarts/components exports](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/export/components.ts)).

### TypeScript types ship in the package

Yes — `package.json` declares `"types": "types/dist/echarts.d.cts"`, so no `@types/echarts` is needed ([package.json](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/package.json)). `EChartsOption` is a public exported interface ([`src/export/option.ts` L262](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/export/option.ts#L262)), re-exported from the standalone entry ([`src/export/all.ts`](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/export/all.ts)).

On the tree-shaking path the handbook recommends composing a **narrower** option type instead: "For developers who are using TypeScript to develop ECharts, type interface is provided to create a minimal `EChartsOption` type. This type will be stricter than the default one provided because it will know exactly what components are being used. This can help you check for missing components or charts more effectively." ([handbook, creating an Option type in TypeScript](https://echarts.apache.org/handbook/en/basics/import)). `ComposeOption` is exported from `echarts/core` ([`src/export/core.ts` L129-135](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/export/core.ts#L129-L135)). Component option types use the `ComponentOption` suffix and series types the `SeriesOption` suffix ([handbook](https://echarts.apache.org/handbook/en/basics/import)).

Recommended setup for this dashboard:

```ts
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import type { LineSeriesOption, BarSeriesOption } from 'echarts/charts';
import type {
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
  DataZoomComponentOption,
} from 'echarts/components';
import type { ComposeOption } from 'echarts/core';

export type ECOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
>;

// MUST run before echarts.init
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
```

The handbook also notes a shortcut for generating this: "The 'Full Code' tab on our sample editor page provides a very convenient way to generate a tree-shakable code." ([handbook](https://echarts.apache.org/handbook/en/basics/import)).

### Container sizing, `resize()`, and teardown

`resize` "Resizes chart, **which should be called manually when container size changes**" ([echartsInstance.resize](https://echarts.apache.org/en/api.html#echartsInstance.resize); [doc source](https://github.com/apache/echarts-doc/blob/master/en/api/echarts-instance.md)) — ECharts does not observe the container for you. The handbook's documented pattern is to listen for the window event: "You can listen to `resize` of the site to catch the event that the browser is resized. Then use `echartsInstance.resize` to resize the chart." ([handbook, reactive of the container size](https://echarts.apache.org/handbook/en/concepts/chart-size)).

Two related gotchas, both documented:

- The container must have dimensions first: "before calling `echarts.init`, you need to make sure the container already has width and height" ([handbook](https://echarts.apache.org/handbook/en/concepts/chart-size)). Otherwise "If DIV is hidden, ECharts initialization tends to fail due to the lack of width and height information. In this case, you can explicitly specify `style.width` and `style.height` of DIV, or manually call `echartsInstance.resize` after showing DIV." ([echarts.init](https://echarts.apache.org/en/api.html#echarts.init)).
- Same fix for hidden tabs/panels: "Sometimes charts may be placed in multiple tabs. Those in hidden labels may fail to initialize due to the ignorance of container width and height. So `resize` should be called manually to get the correct width and height when switching to the corresponding tabs" ([echartsInstance.resize](https://echarts.apache.org/en/api.html#echartsInstance.resize)).

**Teardown: `chart.dispose()`** — "Disposes instance. Once disposed, the instance can not be used again." ([echartsInstance.dispose](https://echarts.apache.org/en/api.html#echartsInstance.dispose)). The static form `echarts.dispose(target)` accepts an instance or the DOM element: "Destroys chart instance, after which the instance cannot be used any more." ([echarts.dispose](https://echarts.apache.org/en/api.html#echarts.dispose)). `echarts.getInstanceByDom(target)` retrieves an existing instance for a container, which is the way to avoid double-init on hot reload ([echarts.getInstanceByDom](https://echarts.apache.org/en/api.html#echarts.getInstanceByDom)).

`ResizeObserver` is not mentioned by the ECharts docs; it is a standard browser API and a reasonable substitute for the window-`resize` listener, but only the window pattern is officially documented.

```ts
const el = document.getElementById('cashflow')!; // must already have width/height
const chart = echarts.init(el);
chart.setOption(option satisfies ECOption);

const onResize = () => chart.resize();
window.addEventListener('resize', onResize);

// teardown
function destroy(): void {
  window.removeEventListener('resize', onResize);
  chart.dispose();
}
```

Note `resize` also accepts `{ silent: true }` to avoid triggering events, which is worth using if a resize would otherwise fire into the range-sync handler ([echartsInstance.resize](https://echarts.apache.org/en/api.html#echartsInstance.resize)).

## 6. Contradictions / flags

The locked assumption — ECharts gives clickable legend toggling and dataZoom range selection natively, with no custom code — **holds for a single chart**. It does **not** hold for the multi-chart requirement. Specifics:

**Confirmed, no custom code:**

- Legend click-to-toggle is native and on by default ([legend](https://echarts.apache.org/en/option.html#legend), [legend.selectedMode](https://echarts.apache.org/en/option.html#legend.selectedMode)).
- dataZoom range selection (slider brush/drag, inside pan/wheel) is native ([dataZoom](https://echarts.apache.org/en/option.html#dataZoom), [dataZoom-slider](https://echarts.apache.org/en/option.html#dataZoom-slider)).
- Multiple dataZoom components on the **same axis in the same instance** auto-link with no code ([dataZoom](https://echarts.apache.org/en/option.html#dataZoom); [doc source, line 31](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)).

**Flag 1 — the map's rationale is wrong that no code is needed for multi-chart range linking.** Of the three linking approaches, only one is code-free, and it comes with a side effect:

| Approach | Custom code? | Caveat |
| --- | --- | --- |
| `echarts.connect` | **No** — one line ([echarts.connect](https://echarts.apache.org/en/api.html#echarts.connect)) | **Cannot be scoped to dataZoom.** It propagates *every* registered action, legend selection included ([`echarts.ts` L3183-3187](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L3183-L3187)) |
| Manual `datazoom` → `dispatchAction` | **Yes** — event handler + loop guard | Selective; the recommended option |
| `axisPointer.link` | No | Crosshair only, and **within a single instance** — does not sync zoom, does not cross instances ([axisPointer.link](https://echarts.apache.org/en/option.html#axisPointer.link)) |

So the two requirements pull against each other: if legends must be independent per chart (likely, since the charts show different series), `connect` is unusable for range-sync and **custom code is unavoidable**. This directly contradicts "no custom code needed" for the multi-chart case. The code is small (~15 lines) — the decision to choose ECharts still stands — but the rationale as written is inaccurate and should be corrected.

**Flag 2 — the `datazoom` event payload is under-documented and shape-varying.** The published payload shows `start`/`end` at the top level ([events.datazoom](https://echarts.apache.org/en/api.html#events.datazoom)), but:

- `inside` pan/wheel delivers a **`batch` array** with no top-level `start`/`end` ([`roams.ts` L124-168](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/roams.ts#L124-L168), [`echarts.ts` L2234-2245](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/core/echarts.ts#L2234-L2245)); `batch` is not mentioned in the events reference at all.
- `startValue`/`endValue` are absent unless the zoom came from the toolbar ([events.datazoom](https://echarts.apache.org/en/api.html#events.datazoom)) — so absolute dates cannot be read from the payload in the normal case.

Reading the range therefore **requires** the `chart.getOption().dataZoom[0]` fallback, i.e. more custom code than "just listen to the event" implies. Mitigation is documented and reliable ([echartsInstance.getOption](https://echarts.apache.org/en/api.html#echartsInstance.getOption); [`dataZoomProcessor.ts` L121-135](https://github.com/apache/echarts/blob/30076aedcd7b7f65d8dd8e8d9ece46ce778133a3/src/component/dataZoom/dataZoomProcessor.ts#L121-L135)).

**Flag 3 — `filterMode` defaults can undermine forecast-vs-actual comparison.** With the default `'filter'`, zooming x rescales y ([dataZoom.filterMode](https://echarts.apache.org/en/option.html#dataZoom.filterMode)), so two charts on an identical time range can show different y-scales. Needs a deliberate choice of `'empty'` plus shared `yAxis.min`/`max` ([doc source, lines 339-342](https://github.com/apache/echarts-doc/blob/master/en/option/component/data-zoom.md)). Not a contradiction, but a configuration decision the "works natively" framing hides.

**Flag 4 — `resize()` is not automatic.** ECharts requires a manual `resize()` call on container size change ([echartsInstance.resize](https://echarts.apache.org/en/api.html#echartsInstance.resize)); a responsive multi-chart dashboard needs a listener per chart plus `dispose()` on teardown. Small, but it is custom code.

**Flag 5 — unverifiable bundle-size claim.** The docs only say tree-shaking "substantially decrease[s] bundle size" / yields "a minimal bundle" ([handbook](https://echarts.apache.org/handbook/en/basics/import)); no official percentage or kB figure exists. Any specific number in planning docs should be measured locally, not cited.

**Flag 6 — no contradiction found on legend behaviour.** The one trap is event naming: user clicks emit `legendselectchanged`, **not** `legendselected` ([events.legendselectchanged](https://echarts.apache.org/en/api.html#events.legendselectchanged), [handbook](https://echarts.apache.org/handbook/en/concepts/event)). Listening to the wrong one yields a handler that silently never fires.

