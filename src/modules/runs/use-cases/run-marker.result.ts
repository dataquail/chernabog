// A marker a run holds or held, and what releasing ended runs' markers did,
// as the use-cases that change them return them and the daemon's protocol
// carries them.
export {
  MarkerReleases,
  RunMarkerView,
} from "../domain/run-marker/run-marker-view.value-object.ts";
