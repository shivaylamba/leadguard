# Accessibility conventions (Merge Forward)

The UI in `app/public/` must work for everyone. Flag:

- Interactive elements without an accessible name (buttons, inputs, selects need visible text or a `<label>`).
- Status shown only by colour: "Full", "Filling up" and "Seats free" must always be written as text too.
- Dynamic updates (search results, room full) that aren't announced through the `#live` aria-live region.
- Focus that is lost after navigation, or controls that can't be reached by keyboard.
- Text contrast below 4.5:1 against its background, in both the light and dark palettes.
- Any value inserted into HTML without `esc()`.
