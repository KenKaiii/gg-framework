// @ts-check
// Per-material shader patch that swaps only skin + hair texels of the KayKit gradient atlas.
// Skin = warm, light, mid-saturation texels (any mesh: face, hands). Hair = texels near the
// character's own hair swatch on the head mesh only, excluding the bluish-dark eye texels.
import * as THREE from 'three';

/** Reference hair colour per head (sampled from the atlases with a UV histogram of each head mesh). */
export const HAIR_REF = { rogue: '#925240', hooded: '#a26149', knight: '#dcb281', mage: '#2a2629', barbarian: '#8a8079' };
const SKIN_REF_V = 0.96;

/**
 * vertexTint: the material uses per-vertex tint colours (merged body parts). Skin/hair texels ignore the tint (as with
 * material.color before), and each vertex adds tint * vertexTint to emissive (the old per-part emissive term).
 * @param {THREE.MeshStandardMaterial} m @param {{skin:string, hair:string, hairRef?:string, head:boolean, vertexTint?: number}} o
 */
export function patchRecolor(m, o) {
  const toLin = c => new THREE.Color(c); // THREE.Color hex input is sRGB -> stored linear
  const ref = new THREE.Color(o.hairRef || '#000000');
  const U = { uSkin: { value: toLin(o.skin) }, uHair: { value: toLin(o.hair) }, uHairRef: { value: new THREE.Vector3(...ref.clone().convertLinearToSRGB().toArray()) }, uHead: { value: o.head && o.hairRef ? 1 : 0 }, uVTint: { value: o.vertexTint || 0 } };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = 'uniform vec3 uSkin; uniform vec3 uHair; uniform vec3 uHairRef; uniform float uHead; uniform float uVTint;\n' + sh.fragmentShader.replace('#include <map_fragment>', `
      vec4 sd = texture2D( map, vMapUv );
      vec3 cs = pow( max(sd.rgb, 0.0), vec3(1.0/2.2) );
      float mx = max(cs.r, max(cs.g, cs.b)), mn = min(cs.r, min(cs.g, cs.b)), ch = mx - mn;
      float hue = ch > 0.0 && mx == cs.r ? mod((cs.g - cs.b) / max(ch, 1e-4), 6.0) / 6.0 : 0.5;
      float sat = mx > 0.0 ? ch / mx : 0.0;
      // hair first: light heads (knight's blond) sit inside the skin hue band, so a texel that matches the head's own
      // hair swatch closely is hair even if it would also pass the skin test
      bool nearHair = uHead > 0.5 && distance(cs, uHairRef) < 0.07 && cs.r >= cs.b - 0.004;
      bool isSkin = !nearHair && hue > 0.02 && hue < 0.12 && sat > 0.18 && sat < 0.56 && mx > 0.9;
      bool isHair = nearHair || (uHead > 0.5 && !isSkin && distance(cs, uHairRef) < 0.16 && cs.r >= cs.b - 0.004);
      if (isSkin) { diffuseColor.rgb = uSkin * pow(mx / ${SKIN_REF_V.toFixed(2)}, 2.2); }
      else if (isHair) { float l = dot(cs, vec3(0.3,0.59,0.11)) / max(dot(uHairRef, vec3(0.3,0.59,0.11)), 0.05); diffuseColor.rgb = uHair * pow(clamp(l, 0.5, 1.6), 2.2); }
      else diffuseColor *= sd;`).replace('#include <color_fragment>', `
      #if defined( USE_COLOR )
        if (!isSkin && !isHair) diffuseColor.rgb *= vColor.rgb;
        totalEmissiveRadiance += vColor.rgb * uVTint;
      #endif`);
  };
  m.customProgramCacheKey = () => 'recolor2';
  return m;
}
