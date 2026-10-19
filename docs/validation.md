# Validating the voice alphabet

The voices' `phoneme_id_map` contains 130 IPA symbols for *every* Swedish voice,
but only the symbols that appeared in a voice's training corpus are actually
voiced. fras targets the **pre-espeak-ng-PR#2364** Swedish inventory, which is
what the voices learned.

Consumers hand these phonemes to Piper as one raw-phoneme block
(`piperBlocks()`, see the README), so espeak-ng never phonetizes; the audit below
guarantees nothing is silently dropped at synthesis time.

## Static check (no Piper needed)

```sh
node tools/audit-voice.ts --voice /path/to/sv_SE-alma-medium.onnx
```

This confirms every symbol the active profile can emit is present in the voice's
`phoneme_id_map`, so nothing is silently dropped at synthesis time.

## Dynamic check (needs Piper)

Presence in the map is necessary but not sufficient: a symbol can be present yet
untrained (the PR#2364 retroflexes and `ɧ` are the known cases). To confirm a
symbol is actually *voiced*, synthesize it in context and compare.

A practical procedure, using the voxos `.venv`:

```sh
cd /path/to/voxos
.venv/bin/python - <<'PY'
import numpy as np
from piper.voice import PiperVoice
from piper.config import SynthesisConfig
v = PiperVoice.load(".voices/sv_SE-alma-medium.onnx",
                    config_path=".voices/sv_SE-alma-medium.onnx.json")
sc = SynthesisConfig()
def rms(ph):
    ids = v.phonemes_to_ids(list(ph))
    a = np.asarray(v.phoneme_ids_to_audio(ids, sc), dtype=np.float32).reshape(-1)
    return float(np.sqrt(np.mean(a**2))), a.size
for ph in ["a", "aː", "ɑː", "ɛ", "eː", "iː", "ʉ", "ʉː", "uː", "ʏ", "øː", "œ",
           "ɔ", "oː", "ɵ", "ʊ", "ə", "r", "t", "d", "n", "l", "s", "ʂ", "ɕ",
           "ʃ", "ɧ", "ʈ", "ɖ", "ɳ", "ɭ", "ɡ", "ŋ"]:
    e, n = rms(ph)
    print(f"{ph!r:8} rms={e:8.4f} n={n}")
PY
```

Untrained symbols tend to be shorter and/or atypical in energy and duration.
When this contradicts the profile, adjust `SV_VOICE_MAP` in `src/to-voice-ipa.ts`.

### Known open questions

- `ʉ` vs `ʉː` for NST `}:` (PR#2364 changed espeak's `u-` from `ipa ʉ` to `ipa ʉː`;
  fras currently emits `ʉː`, matching the post-PR pipeline).
- bare `e` (fras maps NST short `e` to `ɛ`, because espeak never emitted bare `e`).
- `ʃ` vs `ɕ` for the sje-sound (fras follows the established voxos convention: `ʃ`).
- diphthong rendering for NST `a*U` / `E*U` (currently `aʊ` / `eʊ`).
