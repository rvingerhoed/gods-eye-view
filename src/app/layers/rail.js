import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import { createRailLayer } from '../../layers/rail/index.js';

/**
 * Construct one Spoor NL layer using the application scene owners.
 *
 * It takes no catalog source: the network, stations and trips come from the
 * same-origin `/api/ns/*` proxy on first enable.
 * @returns {object} A fresh layer instance for this catalog.
 */
export function createApplicationRail() {
  return createRailLayer({ services: { render, sprites, picking, input } });
}
