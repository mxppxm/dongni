// The original BoopFace 0.8.0 runtime is kept intact. This extension replaces
// its artwork, retaining its actual eyes, action scheduler and gesture physics.
import BoopFace from '../vendor/boopface/boopface.js';
import { registerAvatarExtension } from '../vendor/boopface/src/boopface-extension-host.js';

const NS = 'http://www.w3.org/2000/svg';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const art = `
<defs>
 <linearGradient id="minHair" x2=".3" y2="1"><stop stop-color="#98694e"/><stop offset=".48" stop-color="#6e4635"/><stop offset="1" stop-color="#483027"/></linearGradient>
 <radialGradient id="minSkin" cx=".42" cy=".38" r=".7"><stop stop-color="#ffe5cf"/><stop offset="1" stop-color="#edb69b"/></radialGradient>
 <linearGradient id="minHoodie" x2=".7" y2="1"><stop stop-color="#bdd0a9"/><stop offset="1" stop-color="#7f9c79"/></linearGradient>
 <radialGradient id="minIris"><stop stop-color="#b98647"/><stop offset=".65" stop-color="#81552e"/><stop offset="1" stop-color="#483028"/></radialGradient>
 <clipPath id="minFaceBoundary"><path d="M52 103C54 60 82 43 120 43C160 43 188 65 189 107L182 140Q176 174 121 181Q67 176 59 144Z"/></clipPath>
 <radialGradient id="minBlush"><stop stop-color="#ec9a88" stop-opacity=".65"/><stop offset="1" stop-color="#ec9a88" stop-opacity="0"/></radialGradient>
</defs>
<g id="minArt" stroke="#624334" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round">
 <g id="minPony" transform="rotate(0 168 48)">
  <path d="M159 42C158 14 189 7 202 29C226 29 228 52 213 64C233 76 225 97 216 104Q224 120 211 133Q193 126 197 109C184 105 187 91 194 84C180 77 179 62 159 42Z" fill="url(#minHair)"/>
  <path d="M181 27Q208 32 197 55M193 61Q215 76 203 87M172 31Q190 24 195 34" fill="none" stroke="#c3916c" stroke-opacity=".65"/>
  <path d="M156 36Q168 27 180 39L177 51Q166 56 155 47Z" fill="#eeb476" stroke="#b47949"/>
 </g>
 <path d="M76 184Q61 189 63 214L62 234Q120 246 178 234L176 211Q178 190 162 184Z" fill="url(#minHoodie)"/>
 <path d="M106 167L105 191Q120 201 136 191L134 167" fill="url(#minSkin)"/>
 <path d="M100 187L120 205L140 187L133 180L120 191L108 180Z" fill="#fff5e5"/>
 <path d="M102 182Q86 172 77 188L91 206L112 194ZM137 182Q154 172 166 188L151 206L128 194Z" fill="#a8c39b"/>
 <path d="M108 196L107 222M134 196L135 222" stroke="#faf1db" stroke-width="3.5"/>
 <path d="M105 223L109 223M133 223L137 223" stroke="#6c5641" stroke-width="2"/>
 <path d="M90 209Q96 212 100 210M146 210Q151 213 156 209M86 221L83 235M155 221L158 235M95 235Q120 239 146 235" fill="none" stroke="#6f8d6b"/>
 <path d="M47 104C32 67 53 30 93 31C116 11 154 24 178 43C210 67 205 123 187 150L171 166L64 165Q39 148 47 104Z" fill="url(#minHair)"/>
 <ellipse cx="54" cy="124" rx="12" ry="16" fill="url(#minSkin)"/>
 <ellipse cx="187" cy="124" rx="12" ry="16" fill="url(#minSkin)"/>
 <path d="M52 103C54 60 82 43 120 43C160 43 188 65 189 107L182 140Q176 174 121 181Q67 176 59 144Z" fill="url(#minSkin)"/>
 <ellipse cx="75" cy="142" rx="19" ry="11" fill="url(#minBlush)" stroke="none"/>
 <ellipse cx="165" cy="142" rx="19" ry="11" fill="url(#minBlush)" stroke="none"/>
 <path id="minBrowL" d="M77 96Q88 91 99 95" fill="none" stroke="#78513e" stroke-width="2.5"/>
 <path id="minBrowR" d="M142 95Q154 90 165 96" fill="none" stroke="#78513e" stroke-width="2.5"/>
 <g clip-path="url(#minFaceBoundary)"><g id="minEyesL" transform="translate(48 53) scale(.5)"/>
 <g id="minEyesR" transform="translate(72 53) scale(.5)"/></g>
 <path d="M120 138Q117 141 121 141" fill="none" stroke="#ce9b82" stroke-width="1.5"/>
 <path id="minMouth" d="M111 155Q120 162 130 155" fill="none" stroke="#985947" stroke-width="2"/>
 <path d="M46 110Q36 79 60 54Q85 25 120 36Q153 25 179 55Q201 72 193 112Q174 108 164 81Q170 102 156 108Q138 101 125 70Q128 92 119 102Q101 94 95 70Q91 91 77 104L65 91Q66 111 53 118Z" fill="url(#minHair)"/>
 <path d="M63 59Q88 33 111 39M130 37Q155 36 173 54M59 77Q67 55 88 49M105 44Q126 39 143 48M161 55Q174 66 177 78M77 80Q85 67 88 59M111 61Q112 79 119 88M143 66Q148 84 156 93" fill="none" stroke="#ba8a67" stroke-opacity=".65" stroke-width="2"/>
 <path d="M53 104Q41 128 57 151Q65 160 59 170Q43 163 40 147Q32 123 44 111M185 110Q199 135 184 152Q178 159 183 170Q199 159 201 140" fill="url(#minHair)"/>
 <g fill="#edb476" stroke="#a66f46"><circle cx="174" cy="45" r="7"/><circle cx="181" cy="47" r="6"/><circle cx="170" cy="51" r="5"/></g>
 <g id="minArmL">
  <path d="M81 188Q68 184 62 199L48 218Q49 227 63 231Q74 224 82 210L88 199" fill="url(#minHoodie)"/>
  <path id="minHandL" d="M50 215Q44 214 43 220Q41 224 45 228L50 232Q55 236 61 232L65 227" fill="url(#minSkin)"/>
  <path d="M48 222L54 226M53 219L58 223M59 219L62 222" fill="none" stroke="#c38e74" stroke-width="1.1"/>
  <path d="M49 213L66 222" fill="none" stroke="#769372" stroke-width="3"/>
 </g>
 <g id="minArmR">
  <path d="M162 187Q174 185 180 200L193 218Q189 229 178 230L158 207" fill="url(#minHoodie)"/>
  <path d="M191 215Q197 215 198 220Q201 226 195 230L191 233Q183 236 179 228" fill="url(#minSkin)"/>
  <path d="M193 221L186 226M189 219L183 224" fill="none" stroke="#c38e74" stroke-width="1.1"/>
  <path d="M176 222L192 213" fill="none" stroke="#769372" stroke-width="3"/>
 </g>
</g>`;

function attachArt(face) {
  if (face._minArt || !face._headMotion) return;
  const root = face.shadowRoot;
  const group = document.createElementNS(NS, 'g');
  group.innerHTML = art;
  face._headMotion.appendChild(group);
  face._head.style.display = 'none';
  const style = document.createElement('style');
  style.textContent = `:host([data-character="min"]){overflow:visible} #antennaDot{display:none} #headMotion{transform-origin:120px 142px} #minArt{pointer-events:none}`;
  root.appendChild(style);
  root.querySelector('svg').setAttribute('aria-label', '敏：棕色马尾、绿色卫衣的小姑娘');
  for (const side of ['left', 'right']) {
    const eye = face[`_${side}Eye`];
    const base = face[`_${side}Base`];
    const iris = document.createElementNS(NS, 'g');
    iris.innerHTML = `<clipPath id="${side}MinClip"><use href="#${side}Base"/></clipPath><g clip-path="url(#${side}MinClip)"><ellipse cy="2" rx="19" ry="27" fill="url(#minIris)"/><ellipse cy="3" rx="10" ry="17" fill="#3c2a24"/><ellipse cx="-7" cy="-10" rx="6" ry="8" fill="#fff"/><circle cx="8" cy="12" r="3" fill="#fff5d4"/></g>`;
    const lids = eye.children[2];
    lids.style.display = 'none';
    const visible = document.createElementNS(NS, 'g');
    visible.setAttribute('clip-path', `url(#${side}MinLids)`);
    const clip = document.createElementNS(NS, 'clipPath');
    clip.id = `${side}MinLids`;
    clip.innerHTML = `<path id="${side}MinLidShape" d="M-70-36H70V36H-70Z"/>`;
    eye.insertBefore(clip, eye.firstChild);
    eye.insertBefore(visible, lids);
    visible.append(base, face[`_${side}InputBase`], iris);
    base.setAttribute('stroke', '#624334');
    base.setAttribute('stroke-width', '3.2');
    base.setAttribute('fill', '#fffdf8');
    face[`_${side}InputBase`].setAttribute('fill', '#76523c');
    root.getElementById(side === 'left' ? 'minEyesL' : 'minEyesR').appendChild(eye);
    iris.id = `${side}MinIris`;
  }
  face._minArt = {
    arm: root.getElementById('minArmL'), hand: root.getElementById('minHandL'), otherArm: root.getElementById('minArmR'),
    pony: root.getElementById('minPony'), mouth: root.getElementById('minMouth'),
    browL: root.getElementById('minBrowL'), browR: root.getElementById('minBrowR'),
    irisL: root.getElementById('leftMinIris'), irisR: root.getElementById('rightMinIris'),
    lidL: root.getElementById('leftMinLidShape'), lidR: root.getElementById('rightMinLidShape'),
    motion: matchMedia('(prefers-reduced-motion: reduce)'),
  };
  face.dataset.engine = 'boopface-0.8.0';
}

registerAvatarExtension({
  name: 'dongni-min-character',
  beforePlay(action) {
    if (this.getAttribute('data-character') !== 'min') return;
    if (['affirm', 'send', 'success', 'love'].includes(action)) this._minWaveAt = performance.now();
  },
  reset() { this._minWaveAt = 0; },
  draw(now) {
    if (this.getAttribute('data-character') !== 'min') return;
    attachArt(this);
    const a = this._minArt;
    if (!a) return;
    const still = this.getAttribute('motion') === 'reduce' || (this.getAttribute('motion') !== 'full' && a.motion.matches);
    const elapsed = this._minWaveAt ? (now - this._minWaveAt) / 1000 : 99;
    const wave = elapsed < 1.2 ? Math.sin(Math.min(1, elapsed / .22) * Math.PI / 2) * Math.min(1, (1.2 - elapsed) / .3) : 0;
    const swing = still ? (elapsed < 1.2 ? 80 : 0) : wave * (86 + Math.sin(elapsed * 16) * 9);
    a.arm.setAttribute('transform', `rotate(${swing.toFixed(2)} 81 189)`);
    a.hand.setAttribute('d', wave > .12 ? 'M48 217Q44 212 41 215L38 222Q36 226 41 229L41 240Q42 244 45 241L47 231L47 245Q49 249 52 245L54 231L56 243Q58 247 60 242L60 230L65 237Q69 239 69 235L65 221Q64 216 60 216Z' : 'M50 215Q44 214 43 220Q41 224 45 228L50 232Q55 236 61 232L65 227');
    a.otherArm.setAttribute('transform', `rotate(${still ? 0 : Math.sin(now / 2100) * 1.8} 162 189)`);
    const tail = still ? 0 : clamp(-this._headFollowVel.rot * .025 + Math.sin(now / 1400) * 1.2, -7, 7);
    a.pony.setAttribute('transform', `rotate(${tail.toFixed(2)} 168 48)`);
    const speaking = this.getAttribute('data-speaking') === 'true';
    const happy = this._state === 'happy' || this._state === 'love' || wave > .1;
    a.mouth.setAttribute('d', speaking && (still || Math.sin(now / 105) > -.1) ? 'M112 154Q120 152 129 154Q128 167 120 167Q112 165 112 154Z' : happy ? 'M109 153Q120 155 132 153Q130 166 120 167Q110 165 109 153Z' : this._state === 'failure' ? 'M112 159Q120 153 130 159' : 'M111 155Q120 162 130 155');
    a.mouth.setAttribute('fill', speaking || happy ? '#c5786b' : 'none');
    const p = this._pose;
    for (const [side, node] of [['L', a.lidL], ['R', a.lidR]]) {
      const top = p.topY, bottom = p.bottomY;
      const ta = Math.tan((side === 'L' ? p.topAL : p.topAR) * Math.PI / 180);
      const ba = Math.tan((side === 'L' ? p.bottomAL : p.bottomAR) * Math.PI / 180);
      node.setAttribute('d', `M-70 ${top-70*ta}L70 ${top+70*ta}L70 ${bottom+70*ba}L-70 ${bottom-70*ba}Z`);
    }
    a.irisL.setAttribute('opacity', this._leftBase.getAttribute('opacity') || '1');
    a.irisR.setAttribute('opacity', this._rightBase.getAttribute('opacity') || '1');
    const worried = ['wary', 'failure', 'sad'].includes(this._state);
    a.browL.setAttribute('d', worried ? 'M77 97Q90 93 99 89' : 'M77 96Q88 91 99 95');
    a.browR.setAttribute('d', worried ? 'M142 89Q154 93 165 97' : 'M142 95Q154 90 165 96');
  },
});

export { BoopFace };
