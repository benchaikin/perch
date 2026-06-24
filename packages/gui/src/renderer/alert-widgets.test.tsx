/**
 * Tests for the renderer-side AlertWidget registry: registration + lookup by
 * pluginId, the duplicate guard, and that a registered widget renders its
 * alert's opaque payload and fires `onDismiss`. Each test builds its own
 * {@link AlertWidgetRegistry} so registrations don't leak between cases.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  AlertWidgetRegistry,
  alertWidgets,
  type Alert,
  type AlertWidget,
} from "./alert-widgets.js";

afterEach(() => cleanup());

/** A minimal alert with an arbitrary, plugin-defined payload. */
function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "services:perch:api:crashed",
    pluginId: "services",
    raisedAt: 1_700_000_000_000,
    payload: { message: "api-server crashed" },
    ...overrides,
  };
}

test("register then get resolves the widget by pluginId", () => {
  const registry = new AlertWidgetRegistry();
  const widget: AlertWidget = () => <div />;
  registry.register("services", widget);
  assert.equal(registry.get("services"), widget);
});

test("get returns undefined for an unregistered pluginId", () => {
  const registry = new AlertWidgetRegistry();
  assert.equal(registry.get("services"), undefined);
});

test("has reflects whether a pluginId is registered", () => {
  const registry = new AlertWidgetRegistry();
  assert.equal(registry.has("dex"), false);
  registry.register("dex", () => <div />);
  assert.equal(registry.has("dex"), true);
});

test("registering a duplicate pluginId throws", () => {
  const registry = new AlertWidgetRegistry();
  registry.register("services", () => <div />);
  assert.throws(() => registry.register("services", () => <div />), /duplicate AlertWidget/);
});

test("widgets are isolated per pluginId", () => {
  const registry = new AlertWidgetRegistry();
  const services: AlertWidget = () => <div />;
  const dex: AlertWidget = () => <div />;
  registry.register("services", services);
  registry.register("dex", dex);
  assert.equal(registry.get("services"), services);
  assert.equal(registry.get("dex"), dex);
});

test("a registered widget renders its opaque payload and fires onDismiss", () => {
  const registry = new AlertWidgetRegistry();
  // The widget owns all rendering and reads the payload itself — the registry
  // imposes no schema on it.
  const Widget: AlertWidget = ({ alert, onDismiss }) => (
    <div>
      <span>{(alert.payload as { message: string }).message}</span>
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
  registry.register("services", Widget);

  const resolved = registry.get("services");
  assert.ok(resolved, "expected the widget to resolve");

  let dismissed = 0;
  const { getByText } = render(resolved({ alert: makeAlert(), onDismiss: () => (dismissed += 1) }));
  assert.ok(getByText("api-server crashed"), "widget rendered its payload");
  fireEvent.click(getByText("Dismiss"));
  assert.equal(dismissed, 1);
});

test("the shared registry is a usable AlertWidgetRegistry instance", () => {
  assert.ok(alertWidgets instanceof AlertWidgetRegistry);
});
