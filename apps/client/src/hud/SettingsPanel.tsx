import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import { spriteAtlasManifest, type RenderAssets } from '../render-assets.js';
import {
  defaultPreferences,
  displayKey,
  type CameraAction,
  type ClientPreferences,
} from '../preferences.js';
import type { WorldCanvasDebugState, WorldCanvasMetrics } from '../WorldCanvas.js';
import type { TabPanelProps } from './types.js';

export interface SettingsPanelProps extends TabPanelProps {
  readonly preferences: ClientPreferences;
  readonly setPreferences: Dispatch<SetStateAction<ClientPreferences>>;
  readonly rebindCamera: (
    action: CameraAction,
  ) => (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly rendererDebug: WorldCanvasDebugState;
  readonly setRendererDebug: Dispatch<SetStateAction<WorldCanvasDebugState>>;
  readonly canvasMetrics: WorldCanvasMetrics | undefined;
  readonly renderAssets: RenderAssets | undefined;
  readonly messageRate: { readonly received: number; readonly sent: number };
  readonly updateApplicationMs: number;
  readonly notify: (text: string) => void;
}

/** Camera bindings, renderer diagnostics, and the operations overlay. */
export const SettingsPanel = ({
  hidden,
  preferences,
  setPreferences,
  rebindCamera,
  rendererDebug,
  setRendererDebug,
  canvasMetrics,
  renderAssets,
  messageRate,
  updateApplicationMs,
  notify,
}: SettingsPanelProps) => (
  <div
    aria-labelledby="hud-tab-settings"
    className="hud-panel"
    hidden={hidden}
    id="hud-panel-settings"
    role="tabpanel"
    tabIndex={0}
  >
    <section className="settings-panel" aria-labelledby="settings-title">
      <h2 id="settings-title">Accessibility and controls</h2>
      <label htmlFor="text-scale">Text size</label>
      <select
        id="text-scale"
        value={preferences.textScale}
        onChange={(event) =>
          setPreferences((current) => ({
            ...current,
            textScale: Number(event.target.value) as ClientPreferences['textScale'],
          }))
        }
      >
        <option value={100}>Default</option>
        <option value={120}>Large</option>
        <option value={140}>Extra large</option>
      </select>
      <label className="checkbox-label" htmlFor="reduced-motion">
        <input
          id="reduced-motion"
          type="checkbox"
          checked={preferences.reducedMotion}
          onChange={(event) =>
            setPreferences((current) => ({ ...current, reducedMotion: event.target.checked }))
          }
        />
        Reduce motion
      </label>
      <p className="settings-help">Focus a camera binding, then press its replacement key.</p>
      {(
        [
          ['panUp', 'Pan up'],
          ['panLeft', 'Pan left'],
          ['panDown', 'Pan down'],
          ['panRight', 'Pan right'],
        ] as const
      ).map(([action, label]) => (
        <label key={action} htmlFor={`binding-${action}`}>
          {label}
          <input
            id={`binding-${action}`}
            className="binding-input"
            readOnly
            value={displayKey(preferences.camera[action])}
            onKeyDown={rebindCamera(action)}
            aria-describedby="camera-binding-help"
          />
        </label>
      ))}
      <p className="settings-help" id="camera-binding-help">
        Arrow keys always select tiles; camera bindings must be unique.
      </p>
      <button
        type="button"
        onClick={() => {
          setPreferences(defaultPreferences);
          notify('Accessibility and camera controls restored to defaults.');
        }}
      >
        Restore control defaults
      </button>
    </section>
    <details className="renderer-debug">
      <summary>Renderer diagnostics</summary>
      <p>Diagnostics are local-only and do not change the shared world.</p>
      <label className="checkbox-label" htmlFor="renderer-debug-enabled">
        <input
          id="renderer-debug-enabled"
          type="checkbox"
          checked={rendererDebug.enabled}
          onChange={(event) =>
            setRendererDebug((current) => ({ ...current, enabled: event.target.checked }))
          }
        />
        Show map overlays
      </label>
      <label className="checkbox-label" htmlFor="renderer-debug-coordinates">
        <input
          id="renderer-debug-coordinates"
          type="checkbox"
          disabled={!rendererDebug.enabled}
          checked={rendererDebug.showCoordinates}
          onChange={(event) =>
            setRendererDebug((current) => ({
              ...current,
              showCoordinates: event.target.checked,
            }))
          }
        />
        Tile coordinates
      </label>
      <label className="checkbox-label" htmlFor="renderer-debug-chunks">
        <input
          id="renderer-debug-chunks"
          type="checkbox"
          disabled={!rendererDebug.enabled}
          checked={rendererDebug.showChunks}
          onChange={(event) =>
            setRendererDebug((current) => ({ ...current, showChunks: event.target.checked }))
          }
        />
        Chunk labels
      </label>
      <label className="checkbox-label" htmlFor="renderer-debug-entities">
        <input
          id="renderer-debug-entities"
          type="checkbox"
          disabled={!rendererDebug.enabled}
          checked={rendererDebug.showEntityIds}
          onChange={(event) =>
            setRendererDebug((current) => ({
              ...current,
              showEntityIds: event.target.checked,
            }))
          }
        />
        Entity IDs
      </label>
      <label className="checkbox-label" htmlFor="renderer-debug-paths">
        <input
          id="renderer-debug-paths"
          type="checkbox"
          disabled={!rendererDebug.enabled}
          checked={rendererDebug.showPaths}
          onChange={(event) =>
            setRendererDebug((current) => ({ ...current, showPaths: event.target.checked }))
          }
        />
        Threat paths
      </label>
    </details>
    <details className="performance-panel">
      <summary>Performance</summary>
      <p>
        {canvasMetrics?.framesPerSecond ?? '—'} FPS · {canvasMetrics?.renderedTiles ?? '—'} tiles ·{' '}
        {canvasMetrics?.visibleBuildings ?? '—'} buildings · {canvasMetrics?.visibleThreats ?? '—'}{' '}
        threats
      </p>
      <p>
        {canvasMetrics?.activeChunks ?? '—'} active chunks · {messageRate.received} received/s ·{' '}
        {messageRate.sent} sent/s
      </p>
      <p>
        {canvasMetrics?.renderObjectCount ?? '—'} render objects ·{' '}
        {renderAssets
          ? Math.round(
              Object.values(spriteAtlasManifest).reduce(
                (bytes, atlas) => bytes + atlas.width * atlas.height * 4,
                0,
              ) / 1024,
            )
          : '—'}{' '}
        KiB estimated atlas memory · {updateApplicationMs.toFixed(2)} ms update apply
      </p>
    </details>{' '}
  </div>
);
