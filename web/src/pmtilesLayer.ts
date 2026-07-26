// A deck.gl MVTLayer backed by a local PMTiles archive, used as the citywide
// parcel overview at zooms where loading full GeoJSON chunks would be too heavy.
import { MVTLayer, type MVTLayerProps } from '@deck.gl/geo-layers';
import { PMTiles } from 'pmtiles';

const archives = new Map<string, PMTiles>();

function archiveFor(url: string): PMTiles {
  let p = archives.get(url);
  if (!p) {
    p = new PMTiles(url);
    archives.set(url, p);
  }
  return p;
}

// MVTLayer subclass that pulls raw MVT tiles from a PMTiles file instead of an
// {z}/{x}/{y} tile server. Returns null for absent tiles (PMTiles omits empties).
export class PMTilesLayer<
  DataT = unknown,
  ExtraProps extends object = Record<string, unknown>,
> extends MVTLayer<DataT, ExtraProps & { pmtilesUrl: string }> {
  static layerName = 'PMTilesLayer';

  async getTileData(tile: Parameters<MVTLayer['getTileData']>[0]) {
    const { pmtilesUrl } = this.props as unknown as { pmtilesUrl: string };
    const { x, y, z } = tile.index;
    const archive = archiveFor(pmtilesUrl);
    const result = await archive.getZxy(z, x, y, tile.signal);
    if (!result) return [];
    const buf = result.data;
    // reuse MVTLayer's own MVT parsing on the raw protobuf bytes
    return super.getTileData({
      ...tile,
      data: new Uint8Array(buf),
    } as never);
  }
}

export type PMTilesLayerProps<DataT = unknown> = MVTLayerProps<DataT> & {
  pmtilesUrl: string;
};
