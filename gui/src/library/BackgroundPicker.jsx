import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BUNDLED_TEXTURES, pickImageAsDataUrl, textureUrl } from '../platform/store.js'
import { checkTokens, describeFailure } from './contrast.js'
import { clampPercent, isUsableImageData, PANEL_ALPHA_FLOOR, panelAlpha } from './backgrounds.js'
import { backgroundOverlays, imageBackdrops, resolveTextureWash } from './image-metrics.js'
import { RadioGroup, RadioGroupItem } from './ui/radio-group.jsx'
import { Button } from './ui/button.jsx'

/**
 * The file limit, as the reader is told it.
 *
 * Three megabytes, not four, and the difference is base64. `MAX_BYTES` in
 * `images.rs` is derived from the 4 MiB *stored* cap because the encoded form is
 * a third larger than the file, so the largest file that can actually be saved is
 * just under 3 MB. Promising "up to 4 MB" invited a 3.5 MB photo that passed
 * every check in the picker, looked fine, and was then dropped without a word
 * on save. `tests/custom-theme-contract.test.mjs` pins this string against the
 * Rust expression so the two cannot drift apart again.
 */
const MAX_IMAGE_LABEL = 'up to 3 MB'

/**
 * P4-2, P4-3 and P4-4 in one control: the editor's paper texture, the app's
 * wallpaper, and the two sliders that make either one readable.
 *
 * The composited contrast check lives here rather than in the save path because
 * the reader has to be able to see the failure while they fix it. A gate that
 * runs on submit tells someone their wallpaper is too bright; a gate that runs
 * as they move the dim slider tells them which direction to move it.
 *
 * `settings` is the draft, `onChange` updates it, and `onPreview` applies it
 * live. Both are needed because a background is judged by looking at it, and a
 * draft that only appears on submit makes that impossible. The dialog's Cancel
 * restores whatever was saved, exactly as it does for the theme.
 */
export default function BackgroundPicker({ settings, onChange, onPreview, themeTokens, themeMode = 'light' }) {
  const [wallpaperBackdrops, setWallpaperBackdrops] = useState(null)
  const [textureBackdrops, setTextureBackdrops] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const wallpaperRequest = useRef(0)
  const textureRequest = useRef(0)

  // Sampling is async and the reader can change the image while it is in
  // flight, so each run is numbered and a stale result is dropped. Without this
  // the gate describes the previous image for a frame or two after the new one
  // arrives, which reads as the check being wrong.
  const sample = useCallback((value, set, requestRef) => {
    const run = ++requestRef.current
    if (!isUsableImageData(value)) {
      set(null)
      return
    }
    imageBackdrops(value).then((result) => {
      if (requestRef.current === run) set(result)
    })
  }, [])

  useEffect(() => {
    sample(settings.wallpaper, setWallpaperBackdrops, wallpaperRequest)
  }, [settings.wallpaper, sample])

  useEffect(() => {
    sample(settings.editorTextureData, setTextureBackdrops, textureRequest)
  }, [settings.editorTextureData, sample])

  const alpha = panelAlpha(settings.surfaceAlpha) / 100
  // The same resolution the applier uses, from the same function, so the slider
  // and the check can never describe different veils.
  const wash = resolveTextureWash(themeMode, settings.textureWash)
  const failures = useMemo(
    () => checkTokens(themeTokens, undefined, backgroundOverlays(settings, {
      wallpaperBackdrops,
      textureBackdrops,
      alpha,
      wash,
      scrim: clampPercent(settings.scrim, 0) / 100,
    })),
    [themeTokens, settings, wallpaperBackdrops, textureBackdrops, alpha, wash],
  )

  const apply = useCallback((patch) => {
    setError('')
    onChange(patch)
    onPreview(patch)
  }, [onChange, onPreview])

  const choose = useCallback(async (key, setBusyKey) => {
    setBusy(setBusyKey)
    setError('')
    try {
      const image = await pickImageAsDataUrl({ title: key === 'wallpaper' ? 'Choose a wallpaper' : 'Choose a paper texture' })
      if (!image || typeof image.dataUrl !== 'string') return
      // A bundled id would win over the image the reader just chose, so picking
      // one clears the id. The reverse is also true and is handled here: the
      // id is what the row shows as selected.
      if (key === 'wallpaper') {
        // Choosing a wallpaper has to make something happen.
        //
        // `surfaceAlpha` starts at 100, and at 100 both the library and the
        // editor fill with opaque `--main` -- so the wallpaper is painted and
        // then completely covered. Choosing an image and seeing no change is the
        // whole "the background does not work" report, and the fix is not a
        // better explanation in the note above: it is to open the panels up far
        // enough that the picture is actually behind them.
        //
        // 82 rather than something dramatic: panels still read as panels, and the
        // live readability check below immediately says whether this particular
        // image needs more or less. A reader who has already chosen a value keeps
        // it -- this only moves the slider that has never been touched.
        const untouched = clampPercent(settings.surfaceAlpha, 100) >= 100
        apply({
          wallpaper: image.dataUrl,
          scrim: clampPercent(settings.scrim, 0),
          ...(untouched ? { surfaceAlpha: 82 } : {}),
        })
        return
      }
      apply({ editorTexture: '', editorTextureData: image.dataUrl })
    } catch (cause) {
      setError(cause?.message || 'That file could not be used as a background.')
    } finally {
      setBusy('')
    }
  }, [apply, settings.scrim, settings.surfaceAlpha])

  const hasWallpaper = isUsableImageData(settings.wallpaper)
  const hasTexture = Boolean(textureUrl(settings.editorTexture)) || isUsableImageData(settings.editorTextureData)
  // Only a reader's own image can be washed for. The bundled textures are drawn
  // at 5% and there is nothing to tune, so a slider for them would be a control
  // with no visible effect.
  const pickedTexture = isUsableImageData(settings.editorTextureData) && !settings.editorTexture
  const wallSlidersVisible = hasWallpaper

  return (
    <div className="background-picker">
      <fieldset className="background-group">
        <legend className="field-label">Paper texture</legend>
        <p className="dialog-note">Behind the words in the editor. Bundled textures are drawn at about 5% so they never fight the text.</p>
        <RadioGroup
          className="texture-row"
          aria-label="Paper texture"
          value={pickedTexture ? 'custom' : settings.editorTexture || 'none'}
          onValueChange={(value) => {
            if (value === 'none') apply({ editorTexture: '', editorTextureData: '' })
            else if (value === 'custom') choose('texture', 'texture')
            else apply({ editorTexture: value, editorTextureData: '' })
          }}
        >
          <TextureChip value="none" name="None" selected={!hasTexture} onSelect={() => apply({ editorTexture: '', editorTextureData: '' })} />
          {BUNDLED_TEXTURES.map((texture) => (
            <TextureChip
              key={texture.id}
              value={texture.id}
              id={texture.id}
              name={texture.name}
              hint={texture.hint}
              selected={Boolean(settings.editorTexture) && settings.editorTexture === texture.id}
              onSelect={() => apply({ editorTexture: texture.id, editorTextureData: '' })}
            />
          ))}
          <TextureChip
            value="custom"
            name={isUsableImageData(settings.editorTextureData) ? 'Your image' : 'Choose…'}
            selected={Boolean(settings.editorTextureData) && !settings.editorTexture}
            busy={busy === 'texture'}
            previewUrl={settings.editorTexture && isUsableImageData(settings.editorTextureData) ? '' : settings.editorTextureData}
            onSelect={() => choose('texture', 'texture')}
          />
        </RadioGroup>
        {pickedTexture && (
          <label className="slider-row" htmlFor="texture-wash">
            <span><strong>Texture strength</strong><small>How much of your image shows through the page</small></span>
            <input
              id="texture-wash"
              type="range"
              min="0"
              max="40"
              step="1"
              value={Math.round(wash * 100)}
              onChange={(event) => apply({ textureWash: clampPercent(event.target.value, Math.round(wash * 100)) / 100 })}
            />
            <output>{Math.round(wash * 100)}%</output>
          </label>
        )}
        {pickedTexture && (
          <p className="dialog-note">A light theme needs a low strength: its text is dark, and a dark image behind dark text is not readable at any opacity. The check below says so if it is too high.</p>
        )}
        {isUsableImageData(settings.editorTextureData) && (
          <div className="picked-row">
            <span className="picked-swatch" style={{ backgroundImage: `url("${settings.editorTextureData}")` }} aria-hidden="true" />
            <span className="picked-name">Your own image</span>
            <Button type="button" className="soft-button" onClick={() => apply({ editorTexture: '', editorTextureData: '' })}>Remove</Button>
          </div>
        )}
      </fieldset>

      <fieldset className="background-group">
        <legend className="field-label">Wallpaper</legend>
        <p className="dialog-note">Behind the whole app. {MAX_IMAGE_LABEL}. Panel opacity decides how much of it you see through -- 100% hides it completely.</p>
        <RadioGroup
          className="texture-row"
          aria-label="Wallpaper"
          value={hasWallpaper ? 'custom' : 'none'}
          onValueChange={(value) => {
            if (value === 'none') apply({ wallpaper: '' })
            else choose('wallpaper', 'wallpaper')
          }}
        >
          <TextureChip value="none" name="None" selected={!hasWallpaper} onSelect={() => apply({ wallpaper: '' })} />
          <TextureChip
            value="custom"
            name={hasWallpaper ? 'Change…' : 'Choose…'}
            selected={hasWallpaper}
            busy={busy === 'wallpaper'}
            previewUrl={hasWallpaper ? settings.wallpaper : ''}
            onSelect={() => choose('wallpaper', 'wallpaper')}
          />
          {hasWallpaper && (
            <Button type="button" className="soft-button" onClick={() => apply({ wallpaper: '' })}>Remove</Button>
          )}
        </RadioGroup>
      </fieldset>

      {wallSlidersVisible && (
        <fieldset className="background-group">
          <legend className="field-label">Legibility</legend>
          <label className="slider-row" htmlFor="surface-alpha">
            <span><strong>Panel opacity</strong><small>How solid the panels stay over your image</small></span>
            <input
              id="surface-alpha"
              type="range"
              min={PANEL_ALPHA_FLOOR}
              max="100"
              step="1"
              value={panelAlpha(settings.surfaceAlpha)}
              onChange={(event) => apply({ surfaceAlpha: panelAlpha(event.target.value) })}
            />
            <output>{panelAlpha(settings.surfaceAlpha)}%</output>
          </label>
          <details className="background-fine">
            <summary>Fine-tuning</summary>
          <label className="slider-row" htmlFor="wallpaper-scrim">
            <span><strong>Dim</strong><small>Darkens the image itself, not the text</small></span>
            <input
              id="wallpaper-scrim"
              type="range"
              min="0"
              max="80"
              step="1"
              value={clampPercent(settings.scrim, 0)}
              onChange={(event) => apply({ scrim: clampPercent(event.target.value, 0) })}
            />
            <output>{clampPercent(settings.scrim, 0)}%</output>
          </label>
          <p className="dialog-note">Panel opacity stops at {PANEL_ALPHA_FLOOR}%. Below that a bright image shows through far enough to make a dark theme look light, and the check below will say so.</p>
          </details>
        </fieldset>
      )}

      {error && <p className="background-error" role="alert">{error}</p>}

      {(hasWallpaper || pickedTexture) && (
        <div className="background-check">
          <span className="field-label">Readability</span>
          {failures.length === 0 ? (
            <p className="background-check-ok">Every colour clears 4.5:1 over the light and dark parts of your image.</p>
          ) : (
            <>
              <p className="background-check-bad">{failures.length} colour{failures.length === 1 ? '' : 's'} cannot be read over your image.</p>
              <ul className="background-check-list">
                {failures.slice(0, 4).map((failure) => (
                  <li key={`${failure.fg}-${failure.bg}-${failure.label}`}>
                    {describeFailure(failure)}
                    {failure.painted && <span className="background-check-swatch" style={{ background: failure.painted }} aria-hidden="true" />}
                  </li>
                ))}
              </ul>
              <p className="dialog-note">
                {pickedTexture
                  ? 'Lower the texture strength until this is clear. A black overlay cannot rescue the dark end of an image for a theme with dark text, so the strength is the only lever here.'
                  : 'Raise the panel opacity or the dim until this is clear. The change is not saved until you save the dialog.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One swatch in a texture row.
 *
 * `id` is the bundled texture id, or '' for None, the file chooser, and a
 * picked image -- all four have no bundled preview, and the last three say so
 * rather than showing a grey square the reader has to interpret.
 */
function TextureChip({ id = '', value, name, hint, selected, busy, onSelect, previewUrl }) {
  const url = previewUrl || textureUrl(id)
  return (
    <RadioGroupItem
      indicator={false}
      value={value}
      aria-checked={selected}
      className={`texture-chip ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      disabled={busy}
    >
      <span
        className={`texture-chip-preview ${url ? '' : 'plain'}`}
        style={url ? { backgroundImage: `url("${url}")` } : undefined}
        aria-hidden="true"
      />
      <span className="texture-chip-name">{busy ? 'Reading…' : name}</span>
      {hint && <span className="texture-chip-hint">{hint}</span>}
    </RadioGroupItem>
  )
}
