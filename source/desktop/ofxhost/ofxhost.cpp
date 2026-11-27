// ANIME STUDIO — OpenFX host process (ofxhost)
//
// A small, self-contained OpenFX 1.4 image-effect host. The desktop app runs it as a
// separate process (a crashing plug-in can't take the editor down) and talks to it over
// stdin/stdout with a tab-separated line protocol:
//
//   DESCRIBE\t<bundle path>
//     -> PLUGIN\t<idx>\t<identifier>\t<label>\t<group>\t<contexts>\t<temporal 0|1>\t<depths>
//        PARAM\t<pluginIdx>\t<name>\t<type>\t<label>\t<dims>\t<min>\t<max>\t<default,..>\t<choice|choice>\t<page/group hint>
//        END            (or ERR\t<message>)
//   RENDER\t<bundle>\t<idx>\t<w>\t<h>\t<time>\t<in.rgba>\t<out.rgba>\t<name=v,v;name2=v>
//     -> OK\t<ms>      (or ERR\t<message>)
//   PING -> PONG       QUIT -> exits
//
// Images are raw RGBA8, top row first (the host flips to OpenFX's bottom-left origin).
// Identifies itself honestly as "AnimeStudio" — it never impersonates another host.
//
// Built with the official OpenFX headers (BSD-3, see include/LICENSE-openfx.md).

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include "ofxCore.h"
#include "ofxImageEffect.h"
#include "ofxInteract.h"
#include "ofxMemory.h"
#include "ofxMessage.h"
#include "ofxMultiThread.h"
#include "ofxOld.h"
#include "ofxGPURender.h"
#include "ofxParametricParam.h"
#include "ofxParam.h"
#include "ofxProgress.h"
#include "ofxProperty.h"
#include "ofxTimeLine.h"

// ============================================================ properties

struct Prop {
  enum T { Int, Dbl, Str, Ptr } t = Int;
  std::vector<int> i;
  std::vector<double> d;
  std::vector<std::string> s;
  std::vector<void *> p;
  int size() const { return t == Int ? (int)i.size() : t == Dbl ? (int)d.size() : t == Str ? (int)s.size() : (int)p.size(); }
};

struct PropSet {
  std::map<std::string, Prop> m;
  Prop &get(const char *k, Prop::T t) { Prop &p = m[k]; if (p.size() == 0) p.t = t; return p; }
  void setI(const char *k, std::initializer_list<int> v) { Prop &p = m[k]; p = Prop(); p.t = Prop::Int; p.i = v; }
  void setD(const char *k, std::initializer_list<double> v) { Prop &p = m[k]; p = Prop(); p.t = Prop::Dbl; p.d = v; }
  void setS(const char *k, std::initializer_list<const char *> v) { Prop &p = m[k]; p = Prop(); p.t = Prop::Str; for (auto x : v) p.s.push_back(x); }
  void setP(const char *k, void *v) { Prop &p = m[k]; p = Prop(); p.t = Prop::Ptr; p.p = {v}; }
  bool has(const char *k) const { return m.count(k) > 0; }
  std::string str(const char *k, int idx = 0, const char *def = "") const {
    auto it = m.find(k); if (it == m.end() || it->second.t != Prop::Str || idx >= (int)it->second.s.size()) return def; return it->second.s[idx];
  }
  int integer(const char *k, int idx = 0, int def = 0) const {
    auto it = m.find(k); if (it == m.end()) return def;
    if (it->second.t == Prop::Int && idx < (int)it->second.i.size()) return it->second.i[idx];
    if (it->second.t == Prop::Dbl && idx < (int)it->second.d.size()) return (int)it->second.d[idx];
    return def;
  }
  double dbl(const char *k, int idx = 0, double def = 0) const {
    auto it = m.find(k); if (it == m.end()) return def;
    if (it->second.t == Prop::Dbl && idx < (int)it->second.d.size()) return it->second.d[idx];
    if (it->second.t == Prop::Int && idx < (int)it->second.i.size()) return it->second.i[idx];
    return def;
  }
  std::vector<std::string> strs(const char *k) const { auto it = m.find(k); return it == m.end() ? std::vector<std::string>() : it->second.s; }
};
static PropSet *PS(OfxPropertySetHandle h) { return reinterpret_cast<PropSet *>(h); }
static OfxPropertySetHandle H(PropSet *p) { return reinterpret_cast<OfxPropertySetHandle>(p); }

template <class F> static OfxStatus setN(OfxPropertySetHandle h, const char *k, int idx, Prop::T t, F f) {
  if (!h || !k) return kOfxStatErrBadHandle;
  Prop &p = PS(h)->m[k];
  if (p.t != t) { p = Prop(); p.t = t; }
  if (idx < 0) return kOfxStatErrBadIndex;
  f(p, idx);
  return kOfxStatOK;
}
static OfxStatus propSetPointer(OfxPropertySetHandle h, const char *k, int idx, void *v) { return setN(h, k, idx, Prop::Ptr, [&](Prop &p, int i) { if ((int)p.p.size() <= i) p.p.resize(i + 1); p.p[i] = v; }); }
static OfxStatus propSetString(OfxPropertySetHandle h, const char *k, int idx, const char *v) { return setN(h, k, idx, Prop::Str, [&](Prop &p, int i) { if ((int)p.s.size() <= i) p.s.resize(i + 1); p.s[i] = v ? v : ""; }); }
static OfxStatus propSetDouble(OfxPropertySetHandle h, const char *k, int idx, double v) { return setN(h, k, idx, Prop::Dbl, [&](Prop &p, int i) { if ((int)p.d.size() <= i) p.d.resize(i + 1); p.d[i] = v; }); }
static OfxStatus propSetInt(OfxPropertySetHandle h, const char *k, int idx, int v) { return setN(h, k, idx, Prop::Int, [&](Prop &p, int i) { if ((int)p.i.size() <= i) p.i.resize(i + 1); p.i[i] = v; }); }
static OfxStatus propSetPointerN(OfxPropertySetHandle h, const char *k, int n, void *const *v) { for (int i = 0; i < n; i++) propSetPointer(h, k, i, v[i]); if (h) PS(h)->m[k].p.resize(n); return kOfxStatOK; }
static OfxStatus propSetStringN(OfxPropertySetHandle h, const char *k, int n, const char *const *v) { if (!h) return kOfxStatErrBadHandle; Prop &p = PS(h)->m[k]; p = Prop(); p.t = Prop::Str; for (int i = 0; i < n; i++) p.s.push_back(v[i] ? v[i] : ""); return kOfxStatOK; }
static OfxStatus propSetDoubleN(OfxPropertySetHandle h, const char *k, int n, const double *v) { if (!h) return kOfxStatErrBadHandle; Prop &p = PS(h)->m[k]; p = Prop(); p.t = Prop::Dbl; p.d.assign(v, v + n); return kOfxStatOK; }
static OfxStatus propSetIntN(OfxPropertySetHandle h, const char *k, int n, const int *v) { if (!h) return kOfxStatErrBadHandle; Prop &p = PS(h)->m[k]; p = Prop(); p.t = Prop::Int; p.i.assign(v, v + n); return kOfxStatOK; }

static const Prop *findProp(OfxPropertySetHandle h, const char *k) {
  if (!h || !k) return nullptr;
  auto it = PS(h)->m.find(k);
  return it == PS(h)->m.end() ? nullptr : &it->second;
}
static OfxStatus propGetPointer(OfxPropertySetHandle h, const char *k, int idx, void **v) {
  const Prop *p = findProp(h, k); if (!p) return kOfxStatErrUnknown;
  if (p->t != Prop::Ptr) { *v = nullptr; return p->size() ? kOfxStatErrValue : kOfxStatErrUnknown; }
  if (idx < 0 || idx >= (int)p->p.size()) return kOfxStatErrBadIndex;
  *v = p->p[idx]; return kOfxStatOK;
}
static OfxStatus propGetString(OfxPropertySetHandle h, const char *k, int idx, char **v) {
  const Prop *p = findProp(h, k); if (!p) return kOfxStatErrUnknown;
  if (p->t != Prop::Str) return kOfxStatErrValue;
  if (idx < 0 || idx >= (int)p->s.size()) return kOfxStatErrBadIndex;
  *v = const_cast<char *>(p->s[idx].c_str()); return kOfxStatOK;
}
static OfxStatus propGetDouble(OfxPropertySetHandle h, const char *k, int idx, double *v) {
  const Prop *p = findProp(h, k); if (!p) return kOfxStatErrUnknown;
  if (p->t == Prop::Dbl) { if (idx < 0 || idx >= (int)p->d.size()) return kOfxStatErrBadIndex; *v = p->d[idx]; return kOfxStatOK; }
  if (p->t == Prop::Int) { if (idx < 0 || idx >= (int)p->i.size()) return kOfxStatErrBadIndex; *v = p->i[idx]; return kOfxStatOK; }
  return kOfxStatErrValue;
}
static OfxStatus propGetInt(OfxPropertySetHandle h, const char *k, int idx, int *v) {
  const Prop *p = findProp(h, k); if (!p) return kOfxStatErrUnknown;
  if (p->t == Prop::Int) { if (idx < 0 || idx >= (int)p->i.size()) return kOfxStatErrBadIndex; *v = p->i[idx]; return kOfxStatOK; }
  if (p->t == Prop::Dbl) { if (idx < 0 || idx >= (int)p->d.size()) return kOfxStatErrBadIndex; *v = (int)p->d[idx]; return kOfxStatOK; }
  return kOfxStatErrValue;
}
static OfxStatus propGetPointerN(OfxPropertySetHandle h, const char *k, int n, void **v) { for (int i = 0; i < n; i++) { OfxStatus s = propGetPointer(h, k, i, v + i); if (s) return s; } return kOfxStatOK; }
static OfxStatus propGetStringN(OfxPropertySetHandle h, const char *k, int n, char **v) { for (int i = 0; i < n; i++) { OfxStatus s = propGetString(h, k, i, v + i); if (s) return s; } return kOfxStatOK; }
static OfxStatus propGetDoubleN(OfxPropertySetHandle h, const char *k, int n, double *v) { for (int i = 0; i < n; i++) { OfxStatus s = propGetDouble(h, k, i, v + i); if (s) return s; } return kOfxStatOK; }
static OfxStatus propGetIntN(OfxPropertySetHandle h, const char *k, int n, int *v) { for (int i = 0; i < n; i++) { OfxStatus s = propGetInt(h, k, i, v + i); if (s) return s; } return kOfxStatOK; }
static OfxStatus propReset(OfxPropertySetHandle h, const char *k) { if (!h) return kOfxStatErrBadHandle; PS(h)->m.erase(k); return kOfxStatOK; }
static OfxStatus propGetDimension(OfxPropertySetHandle h, const char *k, int *n) { const Prop *p = findProp(h, k); if (!p) return kOfxStatErrUnknown; *n = p->size(); return kOfxStatOK; }

static OfxPropertySuiteV1 gPropSuite = {
  propSetPointer, propSetString, propSetDouble, propSetInt, propSetPointerN, propSetStringN, propSetDoubleN, propSetIntN,
  propGetPointer, propGetString, propGetDouble, propGetInt, propGetPointerN, propGetStringN, propGetDoubleN, propGetIntN,
  propReset, propGetDimension,
};

// ============================================================ params

struct Param {
  std::string name, type;
  PropSet props;
  double v[4] = {0, 0, 0, 0};
  std::string sv;
  int dims() const {
    if (type == kOfxParamTypeRGBA) return 4;
    if (type == kOfxParamTypeRGB || type == kOfxParamTypeDouble3D || type == kOfxParamTypeInteger3D) return 3;
    if (type == kOfxParamTypeDouble2D || type == kOfxParamTypeInteger2D) return 2;
    return 1;
  }
  bool isInt() const { return type == kOfxParamTypeInteger || type == kOfxParamTypeInteger2D || type == kOfxParamTypeInteger3D || type == kOfxParamTypeBoolean || type == kOfxParamTypeChoice; }
  bool isString() const { return type == kOfxParamTypeString || type == kOfxParamTypeCustom; }
  bool numeric() const { return !isString() && type != kOfxParamTypeGroup && type != kOfxParamTypePage && type != kOfxParamTypePushButton && type != "OfxParamTypeParametric"; }
};
struct ParamSet {
  PropSet props;
  std::vector<std::unique_ptr<Param>> list;
  Param *find(const std::string &n) { for (auto &p : list) if (p->name == n) return p.get(); return nullptr; }
};
static ParamSet *PSet(OfxParamSetHandle h) { return reinterpret_cast<ParamSet *>(h); }
static Param *PRM(OfxParamHandle h) { return reinterpret_cast<Param *>(h); }

static OfxStatus paramDefine(OfxParamSetHandle ps, const char *type, const char *name, OfxPropertySetHandle *props) {
  if (!ps || !name || !type) return kOfxStatErrBadHandle;
  if (PSet(ps)->find(name)) return kOfxStatErrExists;
  auto p = std::make_unique<Param>();
  p->name = name; p->type = type;
  p->props.setS(kOfxPropType, {kOfxTypeParameter});
  p->props.setS(kOfxParamPropType, {type});
  p->props.setS(kOfxPropName, {name});
  p->props.setS(kOfxPropLabel, {name});
  p->props.setI(kOfxParamPropSecret, {0});
  p->props.setI(kOfxParamPropAnimates, {1});
  p->props.setI(kOfxParamPropEnabled, {1});
  p->props.setS(kOfxParamPropScriptName, {name});
  p->props.setS(kOfxParamPropHint, {""});
  p->props.setS(kOfxParamPropParent, {""});
  if (props) *props = H(&p->props);
  PSet(ps)->list.push_back(std::move(p));
  return kOfxStatOK;
}
static OfxStatus paramGetHandle(OfxParamSetHandle ps, const char *name, OfxParamHandle *param, OfxPropertySetHandle *props) {
  if (!ps || !name) return kOfxStatErrBadHandle;
  Param *p = PSet(ps)->find(name);
  if (!p) return kOfxStatErrUnknown;
  if (param) *param = reinterpret_cast<OfxParamHandle>(p);
  if (props) *props = H(&p->props);
  return kOfxStatOK;
}
static OfxStatus paramSetGetPropertySet(OfxParamSetHandle ps, OfxPropertySetHandle *props) { if (!ps) return kOfxStatErrBadHandle; *props = H(&PSet(ps)->props); return kOfxStatOK; }
static OfxStatus paramGetPropertySet(OfxParamHandle p, OfxPropertySetHandle *props) { if (!p) return kOfxStatErrBadHandle; *props = H(&PRM(p)->props); return kOfxStatOK; }

static OfxStatus getValueV(Param *p, va_list ap) {
  if (!p) return kOfxStatErrBadHandle;
  if (p->isString()) { char **out = va_arg(ap, char **); *out = const_cast<char *>(p->sv.c_str()); return kOfxStatOK; }
  int n = p->dims();
  for (int k = 0; k < n; k++) {
    if (p->isInt()) { int *o = va_arg(ap, int *); if (o) *o = (int)std::lround(p->v[k]); }
    else { double *o = va_arg(ap, double *); if (o) *o = p->v[k]; }
  }
  return kOfxStatOK;
}
static OfxStatus setValueV(Param *p, va_list ap) {
  if (!p) return kOfxStatErrBadHandle;
  if (p->isString()) { const char *s = va_arg(ap, const char *); p->sv = s ? s : ""; return kOfxStatOK; }
  int n = p->dims();
  for (int k = 0; k < n; k++) { if (p->isInt()) p->v[k] = va_arg(ap, int); else p->v[k] = va_arg(ap, double); }
  return kOfxStatOK;
}
static OfxStatus paramGetValue(OfxParamHandle h, ...) { va_list ap; va_start(ap, h); OfxStatus s = getValueV(PRM(h), ap); va_end(ap); return s; }
static OfxStatus paramGetValueAtTime(OfxParamHandle h, OfxTime t, ...) { va_list ap; va_start(ap, t); OfxStatus s = getValueV(PRM(h), ap); va_end(ap); return s; }
static OfxStatus paramGetDerivative(OfxParamHandle h, OfxTime t, ...) {
  // no animation over a single rendered frame: derivative is zero
  Param *p = PRM(h); if (!p) return kOfxStatErrBadHandle;
  va_list ap; va_start(ap, t);
  for (int k = 0; k < p->dims(); k++) { double *o = va_arg(ap, double *); if (o) *o = 0; }
  va_end(ap); return kOfxStatOK;
}
static OfxStatus paramGetIntegral(OfxParamHandle h, OfxTime t1, OfxTime t2, ...) {
  Param *p = PRM(h); if (!p) return kOfxStatErrBadHandle;
  va_list ap; va_start(ap, t2);
  for (int k = 0; k < p->dims(); k++) { double *o = va_arg(ap, double *); if (o) *o = p->v[k] * (t2 - t1); }
  va_end(ap); return kOfxStatOK;
}
static OfxStatus paramSetValue(OfxParamHandle h, ...) { va_list ap; va_start(ap, h); OfxStatus s = setValueV(PRM(h), ap); va_end(ap); return s; }
static OfxStatus paramSetValueAtTime(OfxParamHandle h, OfxTime t, ...) { va_list ap; va_start(ap, t); OfxStatus s = setValueV(PRM(h), ap); va_end(ap); return s; }
static OfxStatus paramGetNumKeys(OfxParamHandle, unsigned int *n) { *n = 0; return kOfxStatOK; }
static OfxStatus paramGetKeyTime(OfxParamHandle, unsigned int, OfxTime *) { return kOfxStatErrBadIndex; }
static OfxStatus paramGetKeyIndex(OfxParamHandle, OfxTime, int, int *idx) { *idx = -1; return kOfxStatFailed; }
static OfxStatus paramDeleteKey(OfxParamHandle, OfxTime) { return kOfxStatOK; }
static OfxStatus paramDeleteAllKeys(OfxParamHandle) { return kOfxStatOK; }
static OfxStatus paramCopy(OfxParamHandle to, OfxParamHandle from, OfxTime, const OfxRangeD *) {
  if (!to || !from) return kOfxStatErrBadHandle;
  for (int k = 0; k < 4; k++) PRM(to)->v[k] = PRM(from)->v[k];
  PRM(to)->sv = PRM(from)->sv; return kOfxStatOK;
}
static OfxStatus paramEditBegin(OfxParamSetHandle, const char *) { return kOfxStatOK; }
static OfxStatus paramEditEnd(OfxParamSetHandle) { return kOfxStatOK; }

static OfxParameterSuiteV1 gParamSuite = {
  paramDefine, paramGetHandle, paramSetGetPropertySet, paramGetPropertySet, paramGetValue, paramGetValueAtTime,
  paramGetDerivative, paramGetIntegral, paramSetValue, paramSetValueAtTime, paramGetNumKeys, paramGetKeyTime,
  paramGetKeyIndex, paramDeleteKey, paramDeleteAllKeys, paramCopy, paramEditBegin, paramEditEnd,
};

// ============================================================ effects, clips, images

struct Image {
  PropSet props;
  std::vector<unsigned char> buf;
};
struct Clip {
  std::string name;
  PropSet props;
  // set by the host before a render
  Image *frame = nullptr;
};
struct Effect {
  PropSet props;
  ParamSet params;
  std::map<std::string, std::unique_ptr<Clip>> clips;
  std::vector<std::string> clipOrder;
};
static Effect *FX(OfxImageEffectHandle h) { return reinterpret_cast<Effect *>(h); }

static OfxStatus getPropertySet(OfxImageEffectHandle e, OfxPropertySetHandle *p) { if (!e) return kOfxStatErrBadHandle; *p = H(&FX(e)->props); return kOfxStatOK; }
static OfxStatus getParamSet(OfxImageEffectHandle e, OfxParamSetHandle *p) { if (!e) return kOfxStatErrBadHandle; *p = reinterpret_cast<OfxParamSetHandle>(&FX(e)->params); return kOfxStatOK; }
static OfxStatus clipDefine(OfxImageEffectHandle e, const char *name, OfxPropertySetHandle *props) {
  if (!e || !name) return kOfxStatErrBadHandle;
  auto c = std::make_unique<Clip>();
  c->name = name;
  c->props.setS(kOfxPropType, {kOfxTypeClip});
  c->props.setS(kOfxPropName, {name});
  c->props.setS(kOfxPropLabel, {name});
  c->props.setI(kOfxImageClipPropOptional, {0});
  c->props.setI(kOfxImageClipPropIsMask, {0});
  c->props.setI(kOfxImageEffectPropTemporalClipAccess, {0});
  c->props.setI(kOfxImageEffectPropSupportsTiles, {1});
  if (props) *props = H(&c->props);
  FX(e)->clipOrder.push_back(name);
  FX(e)->clips[name] = std::move(c);
  return kOfxStatOK;
}
static OfxStatus clipGetHandle(OfxImageEffectHandle e, const char *name, OfxImageClipHandle *clip, OfxPropertySetHandle *props) {
  if (!e || !name) return kOfxStatErrBadHandle;
  auto it = FX(e)->clips.find(name);
  if (it == FX(e)->clips.end()) return kOfxStatErrUnknown;
  if (clip) *clip = reinterpret_cast<OfxImageClipHandle>(it->second.get());
  if (props) *props = H(&it->second->props);
  return kOfxStatOK;
}
static OfxStatus clipGetPropertySet(OfxImageClipHandle c, OfxPropertySetHandle *p) { if (!c) return kOfxStatErrBadHandle; *p = H(&reinterpret_cast<Clip *>(c)->props); return kOfxStatOK; }
static OfxStatus clipGetImage(OfxImageClipHandle c, OfxTime, const OfxRectD *, OfxPropertySetHandle *img) {
  Clip *clip = reinterpret_cast<Clip *>(c);
  if (!clip) return kOfxStatErrBadHandle;
  if (!clip->frame) return kOfxStatFailed; // unconnected clip
  *img = H(&clip->frame->props);
  return kOfxStatOK;
}
static OfxStatus clipReleaseImage(OfxPropertySetHandle) { return kOfxStatOK; }
static OfxStatus clipGetRegionOfDefinition(OfxImageClipHandle c, OfxTime, OfxRectD *r) {
  Clip *clip = reinterpret_cast<Clip *>(c);
  if (!clip) return kOfxStatErrBadHandle;
  r->x1 = 0; r->y1 = 0;
  r->x2 = clip->frame ? clip->frame->props.integer(kOfxImagePropBounds, 2) : 0;
  r->y2 = clip->frame ? clip->frame->props.integer(kOfxImagePropBounds, 3) : 0;
  return kOfxStatOK;
}
static int abortFn(OfxImageEffectHandle) { return 0; }
struct MemBlock { std::vector<unsigned char> data; };
static OfxStatus imageMemoryAlloc(OfxImageEffectHandle, size_t n, OfxImageMemoryHandle *h) { auto *b = new MemBlock(); b->data.resize(n); *h = reinterpret_cast<OfxImageMemoryHandle>(b); return kOfxStatOK; }
static OfxStatus imageMemoryFree(OfxImageMemoryHandle h) { delete reinterpret_cast<MemBlock *>(h); return kOfxStatOK; }
static OfxStatus imageMemoryLock(OfxImageMemoryHandle h, void **p) { if (!h) return kOfxStatErrBadHandle; *p = reinterpret_cast<MemBlock *>(h)->data.data(); return kOfxStatOK; }
static OfxStatus imageMemoryUnlock(OfxImageMemoryHandle) { return kOfxStatOK; }

static OfxImageEffectSuiteV1 gEffectSuite = {
  getPropertySet, getParamSet, clipDefine, clipGetHandle, clipGetPropertySet, clipGetImage, clipReleaseImage,
  clipGetRegionOfDefinition, abortFn, imageMemoryAlloc, imageMemoryFree, imageMemoryLock, imageMemoryUnlock,
};

// ============================================================ other suites

static OfxStatus memoryAlloc(void *, size_t n, void **p) { *p = std::malloc(n ? n : 1); return *p ? kOfxStatOK : kOfxStatErrMemory; }
static OfxStatus memoryFree(void *p) { std::free(p); return kOfxStatOK; }
static OfxMemorySuiteV1 gMemSuite = {memoryAlloc, memoryFree};

static thread_local unsigned int tThreadIndex = 0;
static thread_local int tSpawned = 0;
static OfxStatus multiThread(OfxThreadFunctionV1 func, unsigned int n, void *arg) {
  if (n <= 1) { func(0, 1, arg); return kOfxStatOK; }
  std::vector<std::thread> ts;
  for (unsigned int i = 0; i < n; i++) ts.emplace_back([=] { tThreadIndex = i; tSpawned = 1; func(i, n, arg); });
  for (auto &t : ts) t.join();
  return kOfxStatOK;
}
static OfxStatus multiThreadNumCPUs(unsigned int *n) { unsigned int c = std::thread::hardware_concurrency(); *n = c ? c : 1; return kOfxStatOK; }
static OfxStatus multiThreadIndex(unsigned int *i) { *i = tThreadIndex; return kOfxStatOK; }
static int multiThreadIsSpawnedThread() { return tSpawned; }
static OfxStatus mutexCreate(OfxMutexHandle *m, int) { *m = reinterpret_cast<OfxMutexHandle>(new std::recursive_mutex()); return kOfxStatOK; }
static OfxStatus mutexDestroy(const OfxMutexHandle m) { delete reinterpret_cast<std::recursive_mutex *>(m); return kOfxStatOK; }
static OfxStatus mutexLock(const OfxMutexHandle m) { reinterpret_cast<std::recursive_mutex *>(m)->lock(); return kOfxStatOK; }
static OfxStatus mutexUnLock(const OfxMutexHandle m) { reinterpret_cast<std::recursive_mutex *>(m)->unlock(); return kOfxStatOK; }
static OfxStatus mutexTryLock(const OfxMutexHandle m) { return reinterpret_cast<std::recursive_mutex *>(m)->try_lock() ? kOfxStatOK : kOfxStatFailed; }
static OfxMultiThreadSuiteV1 gThreadSuite = {multiThread, multiThreadNumCPUs, multiThreadIndex, multiThreadIsSpawnedThread, mutexCreate, mutexDestroy, mutexLock, mutexUnLock, mutexTryLock};

static std::string gLastPluginMessage;
static OfxStatus message(void *, const char *type, const char *, const char *fmt, ...) {
  char buf[2048]; va_list ap; va_start(ap, fmt); std::vsnprintf(buf, sizeof buf, fmt ? fmt : "", ap); va_end(ap);
  gLastPluginMessage = buf;
  std::fprintf(stderr, "[plugin %s] %s\n", type ? type : "", buf);
  if (type && std::strcmp(type, kOfxMessageQuestion) == 0) return kOfxStatReplyYes;
  return kOfxStatOK;
}
static OfxStatus setPersistentMessage(void *, const char *type, const char *, const char *fmt, ...) {
  char buf[2048]; va_list ap; va_start(ap, fmt); std::vsnprintf(buf, sizeof buf, fmt ? fmt : "", ap); va_end(ap);
  gLastPluginMessage = buf;
  std::fprintf(stderr, "[plugin %s] %s\n", type ? type : "", buf);
  return kOfxStatOK;
}
static OfxStatus clearPersistentMessage(void *) { return kOfxStatOK; }
static OfxMessageSuiteV2 gMsgSuite2 = {message, setPersistentMessage, clearPersistentMessage};
static OfxMessageSuiteV1 gMsgSuite1 = {message};

static OfxStatus interactSwapBuffers(OfxInteractHandle) { return kOfxStatOK; }
static OfxStatus interactRedraw(OfxInteractHandle) { return kOfxStatOK; }
static OfxStatus interactGetPropertySet(OfxInteractHandle, OfxPropertySetHandle *p) { static PropSet empty; *p = H(&empty); return kOfxStatOK; }
static OfxInteractSuiteV1 gInteractSuite = {interactSwapBuffers, interactRedraw, interactGetPropertySet};

static OfxStatus progressStart1(void *, const char *) { return kOfxStatOK; }
static OfxStatus progressStart2(void *, const char *, const char *) { return kOfxStatOK; }
static OfxStatus progressUpdate(void *, double) { return kOfxStatOK; }
static OfxStatus progressEnd(void *) { return kOfxStatOK; }
static OfxProgressSuiteV1 gProg1 = {progressStart1, progressUpdate, progressEnd};
static OfxProgressSuiteV2 gProg2 = {progressStart2, progressUpdate, progressEnd};

static double gCurTime = 0, gDuration = 1;
static OfxStatus getTime(void *, double *t) { *t = gCurTime; return kOfxStatOK; }
static OfxStatus gotoTime(void *, double) { return kOfxStatOK; }
static OfxStatus getTimeBounds(void *, double *a, double *b) { *a = 0; *b = gDuration; return kOfxStatOK; }
static OfxTimeLineSuiteV1 gTimeSuite = {getTime, gotoTime, getTimeBounds};

// ============================================================ host

static PropSet gHostProps;
static const void *fetchSuite(OfxPropertySetHandle, const char *name, int version) {
  if (!name) return nullptr;
  std::string n = name;
  if (n == kOfxPropertySuite && version == 1) return &gPropSuite;
  if (n == kOfxImageEffectSuite && version == 1) return &gEffectSuite;
  if (n == kOfxParameterSuite && version == 1) return &gParamSuite;
  if (n == kOfxMemorySuite && version == 1) return &gMemSuite;
  if (n == kOfxMultiThreadSuite && version == 1) return &gThreadSuite;
  if (n == kOfxMessageSuite && version == 1) return &gMsgSuite1;
  if (n == kOfxMessageSuite && version == 2) return &gMsgSuite2;
  if (n == kOfxInteractSuite && version == 1) return &gInteractSuite;
  if (n == kOfxProgressSuite && version == 1) return &gProg1;
  if (n == kOfxProgressSuite && version == 2) return &gProg2;
  if (n == kOfxTimeLineSuite && version == 1) return &gTimeSuite;
  return nullptr; // OpenGL / CUDA / OpenCL / Metal / parametric / dialog: not offered
}
static OfxHost gHost = {nullptr, fetchSuite};

static void initHost() {
  PropSet &h = gHostProps;
  h.setS(kOfxPropType, {kOfxTypeImageEffectHost});
  h.setS(kOfxPropName, {"com.animestudio.host"});
  h.setS(kOfxPropLabel, {"AnimeStudio"});
  h.setI(kOfxPropAPIVersion, {1, 4});
  h.setI(kOfxPropVersion, {1, 0, 0});
  h.setS(kOfxPropVersionLabel, {"1.0"});
  h.setI(kOfxImageEffectHostPropIsBackground, {0});
  h.setI(kOfxImageEffectPropSupportsOverlays, {0});
  h.setI(kOfxImageEffectPropSupportsMultiResolution, {1});
  h.setI(kOfxImageEffectPropSupportsTiles, {1});
  h.setI(kOfxImageEffectPropTemporalClipAccess, {0});
  h.setS(kOfxImageEffectPropSupportedComponents, {kOfxImageComponentRGBA, kOfxImageComponentAlpha});
  h.setS(kOfxImageEffectPropSupportedContexts, {kOfxImageEffectContextFilter, kOfxImageEffectContextGeneral});
  h.setS(kOfxImageEffectPropSupportedPixelDepths, {kOfxBitDepthByte, kOfxBitDepthShort, kOfxBitDepthFloat});
  h.setI(kOfxImageEffectPropSupportsMultipleClipDepths, {0});
  h.setI(kOfxImageEffectPropSupportsMultipleClipPARs, {0});
  h.setI(kOfxImageEffectPropSetableFrameRate, {0});
  h.setI(kOfxImageEffectPropSetableFielding, {0});
  h.setI(kOfxParamHostPropSupportsCustomInteract, {0});
  h.setI(kOfxParamHostPropSupportsStringAnimation, {0});
  h.setI(kOfxParamHostPropSupportsChoiceAnimation, {0});
  h.setI(kOfxParamHostPropSupportsBooleanAnimation, {0});
  h.setI(kOfxParamHostPropSupportsCustomAnimation, {0});
  h.setI(kOfxParamHostPropSupportsParametricAnimation, {0});
  h.setI(kOfxParamHostPropMaxParameters, {-1});
  h.setI(kOfxParamHostPropMaxPages, {0});
  h.setI(kOfxParamHostPropPageRowColumnCount, {0, 0});
  h.setS(kOfxImageEffectHostPropNativeOrigin, {kOfxHostNativeOriginBottomLeft});
  h.setI(kOfxImageEffectInstancePropSequentialRender, {0});
  h.setS(kOfxImageEffectPropOpenGLRenderSupported, {"false"});
  h.setI(kOfxImageEffectPropRenderQualityDraft, {0});
  gHost.host = H(&gHostProps);
}

// ============================================================ plug-in binaries

struct Binary {
  std::string bundle;
  void *lib = nullptr;
  int (*getNum)() = nullptr;
  OfxPlugin *(*getPlugin)(int) = nullptr;
};
struct LoadedPlugin {
  OfxPlugin *p = nullptr;
  bool loaded = false;
  std::unique_ptr<Effect> desc;
  std::string context;
  int depth = 8; // 8 byte, 16 short, 32 float
  std::string err;
};
struct Instance {
  std::unique_ptr<Effect> fx;
  int w = 0, h = 0;
  Image src, out;
};

static std::map<std::string, std::unique_ptr<Binary>> gBins;
static std::map<std::string, std::unique_ptr<LoadedPlugin>> gPlugins;   // bundle|idx
static std::map<std::string, std::unique_ptr<Instance>> gInstances;    // bundle|idx|w|h

static std::string baseName(const std::string &bundle) {
  std::string b = bundle;
  while (!b.empty() && (b.back() == '/' || b.back() == '\\')) b.pop_back();
  size_t s = b.find_last_of("/\\");
  std::string n = s == std::string::npos ? b : b.substr(s + 1);
  const std::string suf = ".ofx.bundle";
  if (n.size() > suf.size() && n.compare(n.size() - suf.size(), suf.size(), suf) == 0) n = n.substr(0, n.size() - suf.size());
  return n;
}

static Binary *openBinary(const std::string &bundle, std::string &err) {
  auto it = gBins.find(bundle);
  if (it != gBins.end()) return it->second.get();
  std::string name = baseName(bundle);
#ifdef _WIN32
  std::string path = bundle + "\\Contents\\Win64\\" + name + ".ofx";
  std::wstring wp(path.begin(), path.end());
  int wl = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  if (wl > 0) { wp.resize(wl); MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wp[0], wl); }
  HMODULE m = LoadLibraryExW(wp.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!m) { err = "LoadLibrary failed (" + std::to_string(GetLastError()) + "): " + path; return nullptr; }
  auto *b = new Binary();
  b->lib = m;
  b->getNum = reinterpret_cast<int (*)()>(GetProcAddress(m, "OfxGetNumberOfPlugins"));
  b->getPlugin = reinterpret_cast<OfxPlugin *(*)(int)>(GetProcAddress(m, "OfxGetPlugin"));
#else
#if defined(__APPLE__)
  std::string path = bundle + "/Contents/MacOS/" + name + ".ofx";
#else
  std::string path = bundle + "/Contents/Linux-x86-64/" + name + ".ofx";
#endif
  void *m = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!m) { const char *e = dlerror(); err = std::string("dlopen failed: ") + (e ? e : path); return nullptr; }
  auto *b = new Binary();
  b->lib = m;
  b->getNum = reinterpret_cast<int (*)()>(dlsym(m, "OfxGetNumberOfPlugins"));
  b->getPlugin = reinterpret_cast<OfxPlugin *(*)(int)>(dlsym(m, "OfxGetPlugin"));
#endif
  b->bundle = bundle;
  if (!b->getNum || !b->getPlugin) { err = "Not an OpenFX plug-in (OfxGetPlugin missing): " + path; delete b; return nullptr; }
  gBins[bundle] = std::unique_ptr<Binary>(b);
  return b;
}

static OfxStatus callAction(OfxPlugin *p, const char *action, const void *handle, PropSet *in, PropSet *out) {
  try {
    return p->mainEntry(action, handle, in ? H(in) : nullptr, out ? H(out) : nullptr);
  } catch (...) {
    return kOfxStatFailed;
  }
}

static LoadedPlugin *loadPlugin(const std::string &bundle, int idx, std::string &err) {
  std::string key = bundle + "|" + std::to_string(idx);
  auto it = gPlugins.find(key);
  if (it != gPlugins.end()) { if (!it->second->err.empty()) err = it->second->err; return it->second->err.empty() ? it->second.get() : nullptr; }
  auto lp = std::make_unique<LoadedPlugin>();
  LoadedPlugin *L = lp.get();
  gPlugins[key] = std::move(lp);
  Binary *b = openBinary(bundle, err);
  if (!b) { L->err = err; return nullptr; }
  if (idx < 0 || idx >= b->getNum()) { L->err = err = "plug-in index out of range"; return nullptr; }
  L->p = b->getPlugin(idx);
  if (!L->p || !L->p->pluginApi || std::strcmp(L->p->pluginApi, kOfxImageEffectPluginApi) != 0) { L->err = err = "not an image-effect plug-in"; return nullptr; }
  L->p->setHost(&gHost);
  OfxStatus s = callAction(L->p, kOfxActionLoad, nullptr, nullptr, nullptr);
  if (s != kOfxStatOK && s != kOfxStatReplyDefault) { L->err = err = "plug-in refused to load (kOfxActionLoad = " + std::to_string(s) + ")" + (gLastPluginMessage.empty() ? "" : ": " + gLastPluginMessage); return nullptr; }
  L->loaded = true;
  // describe
  L->desc = std::make_unique<Effect>();
  Effect *d = L->desc.get();
  d->props.setS(kOfxPropType, {kOfxTypeImageEffect});
  d->props.setS(kOfxPropLabel, {L->p->pluginIdentifier});
  d->props.setS(kOfxImageEffectPluginPropGrouping, {""});
  d->props.setS(kOfxPluginPropFilePath, {bundle.c_str()});
  d->props.setI(kOfxImageEffectPluginPropSingleInstance, {0});
  d->props.setS(kOfxImageEffectPluginRenderThreadSafety, {kOfxImageEffectRenderInstanceSafe});
  d->props.setI(kOfxImageEffectPluginPropHostFrameThreading, {0});
  d->props.setI(kOfxImageEffectPropSupportsMultiResolution, {1});
  d->props.setI(kOfxImageEffectPropSupportsTiles, {1});
  d->props.setI(kOfxImageEffectPropTemporalClipAccess, {0});
  d->props.setS(kOfxImageEffectPropSupportedPixelDepths, {kOfxBitDepthByte});
  d->props.setI(kOfxImageEffectPluginPropFieldRenderTwiceAlways, {0});
  d->props.setI(kOfxImageEffectPropSupportsMultipleClipDepths, {0});
  d->props.setI(kOfxImageEffectPropSupportsMultipleClipPARs, {0});
  s = callAction(L->p, kOfxActionDescribe, d, nullptr, nullptr);
  if (s != kOfxStatOK && s != kOfxStatReplyDefault) { L->err = err = "describe failed (" + std::to_string(s) + ")"; return nullptr; }
  auto ctxs = d->props.strs(kOfxImageEffectPropSupportedContexts);
  bool filter = false, general = false;
  for (auto &c : ctxs) { if (c == kOfxImageEffectContextFilter) filter = true; if (c == kOfxImageEffectContextGeneral) general = true; }
  if (!filter && !general) { L->err = err = "plug-in needs an unsupported context (generator/transition/retimer only)"; return nullptr; }
  L->context = filter ? kOfxImageEffectContextFilter : kOfxImageEffectContextGeneral;
  PropSet in;
  in.setS(kOfxImageEffectPropContext, {L->context.c_str()});
  s = callAction(L->p, kOfxImageEffectActionDescribeInContext, d, &in, nullptr);
  if (s != kOfxStatOK && s != kOfxStatReplyDefault) { L->err = err = "describe-in-context failed (" + std::to_string(s) + ")" + (gLastPluginMessage.empty() ? "" : ": " + gLastPluginMessage); return nullptr; }
  // pixel depth: byte if the plug-in takes it, else float, else short
  auto depths = d->props.strs(kOfxImageEffectPropSupportedPixelDepths);
  bool hasB = false, hasF = false, hasS = false;
  for (auto &x : depths) { if (x == kOfxBitDepthByte) hasB = true; if (x == kOfxBitDepthFloat) hasF = true; if (x == kOfxBitDepthShort) hasS = true; }
  L->depth = hasB ? 8 : hasF ? 32 : hasS ? 16 : 8;
  return L;
}

// ------------------------------------------------------------ param defaults (normalised → canonical)

static bool isSpatialNormalised(const Param &p) {
  std::string dt = p.props.str(kOfxParamPropDoubleType);
  std::string cs = p.props.str(kOfxParamPropDefaultCoordinateSystem);
  bool norm = dt == kOfxParamDoubleTypeNormalisedX || dt == kOfxParamDoubleTypeNormalisedY || dt == kOfxParamDoubleTypeNormalisedXY ||
              dt == kOfxParamDoubleTypeNormalisedXAbsolute || dt == kOfxParamDoubleTypeNormalisedYAbsolute || dt == kOfxParamDoubleTypeNormalisedXYAbsolute;
  bool csNorm = cs == kOfxParamCoordinatesNormalised && (dt == kOfxParamDoubleTypeX || dt == kOfxParamDoubleTypeY || dt == kOfxParamDoubleTypeXY ||
                dt == kOfxParamDoubleTypeXAbsolute || dt == kOfxParamDoubleTypeYAbsolute || dt == kOfxParamDoubleTypeXYAbsolute);
  return norm || csNorm;
}

static void initParamValue(Param &p, int w, int h) {
  int n = p.dims();
  for (int k = 0; k < n; k++) p.v[k] = p.props.dbl(kOfxParamPropDefault, k, 0);
  if (p.isString()) p.sv = p.props.str(kOfxParamPropDefault);
  if (isSpatialNormalised(p)) {
    std::string dt = p.props.str(kOfxParamPropDoubleType);
    bool isY = dt.find('Y') != std::string::npos && dt.find("XY") == std::string::npos;
    for (int k = 0; k < n; k++) p.v[k] *= (n == 2 ? (k == 0 ? w : h) : (isY ? h : w));
  }
}

static std::string clean(std::string s) { for (auto &c : s) if (c == '\t' || c == '\n' || c == '\r') c = ' '; return s; }

static void describe(const std::string &bundle) {
  std::string err;
  Binary *b = openBinary(bundle, err);
  if (!b) { std::cout << "ERR\t" << clean(err) << "\n" << std::flush; return; }
  int n = b->getNum();
  int ok = 0;
  for (int i = 0; i < n; i++) {
    std::string e2;
    gLastPluginMessage.clear();
    LoadedPlugin *L = loadPlugin(bundle, i, e2);
    OfxPlugin *raw = b->getPlugin(i);
    std::string id = raw && raw->pluginIdentifier ? raw->pluginIdentifier : ("plugin" + std::to_string(i));
    if (!L) { std::cout << "SKIP\t" << i << "\t" << clean(id) << "\t" << clean(e2) << "\n"; continue; }
    Effect *d = L->desc.get();
    std::string label = d->props.str(kOfxPropLabel, 0, id.c_str());
    std::string group = d->props.str(kOfxImageEffectPluginPropGrouping);
    int temporal = d->props.integer(kOfxImageEffectPropTemporalClipAccess);
    std::cout << "PLUGIN\t" << i << "\t" << clean(id) << "\t" << clean(label) << "\t" << clean(group) << "\t" << clean(L->context) << "\t" << temporal << "\t" << L->depth << "\n";
    for (auto &pp : d->params.list) {
      Param &p = *pp;
      if (!p.numeric() || p.props.integer(kOfxParamPropSecret)) continue;
      initParamValue(p, 1920, 1080);
      int dims = p.dims();
      double mn = p.props.dbl(kOfxParamPropDisplayMin, 0, p.props.dbl(kOfxParamPropMin, 0, -1e9));
      double mx = p.props.dbl(kOfxParamPropDisplayMax, 0, p.props.dbl(kOfxParamPropMax, 0, 1e9));
      if (p.type == kOfxParamTypeBoolean) { mn = 0; mx = 1; }
      std::string choices;
      if (p.type == kOfxParamTypeChoice) {
        auto opts = p.props.strs(kOfxParamPropChoiceOption);
        for (size_t k = 0; k < opts.size(); k++) { if (k) choices += "|"; std::string o = opts[k]; for (auto &c : o) if (c == '|') c = '/'; choices += o; }
        mn = 0; mx = opts.empty() ? 0 : (double)opts.size() - 1;
      }
      std::ostringstream def;
      for (int k = 0; k < dims; k++) { if (k) def << ","; def << p.props.dbl(kOfxParamPropDefault, k, 0); }
      std::cout << "PARAM\t" << i << "\t" << clean(p.name) << "\t" << clean(p.type) << "\t" << clean(p.props.str(kOfxPropLabel, 0, p.name.c_str()))
                << "\t" << dims << "\t" << mn << "\t" << mx << "\t" << def.str() << "\t" << clean(choices) << "\t" << (isSpatialNormalised(p) ? "spatial" : clean(p.props.str(kOfxParamPropDoubleType))) << "\n";
    }
    ok++;
  }
  if (!ok && n > 0) std::cout << "ERR\tNo usable image effects in this bundle\n";
  std::cout << "END\n" << std::flush;
}

// ------------------------------------------------------------ render

static void setupImage(Image &img, int w, int h, int depth, const char *premult) {
  int bpc = depth / 8;
  img.buf.assign((size_t)w * h * 4 * bpc, 0);
  img.props.m.clear();
  img.props.setS(kOfxPropType, {kOfxTypeImage});
  img.props.setP(kOfxImagePropData, img.buf.data());
  img.props.setI(kOfxImagePropBounds, {0, 0, w, h});
  img.props.setI(kOfxImagePropRegionOfDefinition, {0, 0, w, h});
  img.props.setI(kOfxImagePropRowBytes, {w * 4 * bpc});
  img.props.setS(kOfxImageEffectPropPixelDepth, {depth == 8 ? kOfxBitDepthByte : depth == 16 ? kOfxBitDepthShort : kOfxBitDepthFloat});
  img.props.setS(kOfxImageEffectPropComponents, {kOfxImageComponentRGBA});
  img.props.setS(kOfxImageEffectPropPreMultiplication, {premult});
  img.props.setD(kOfxImageEffectPropRenderScale, {1.0, 1.0});
  img.props.setD(kOfxImagePropPixelAspectRatio, {1.0});
  img.props.setS(kOfxImagePropField, {kOfxImageFieldNone});
  img.props.setS(kOfxImagePropUniqueIdentifier, {"animestudio-frame"});
}

static Instance *getInstance(const std::string &bundle, int idx, int w, int h, std::string &err) {
  std::string key = bundle + "|" + std::to_string(idx) + "|" + std::to_string(w) + "x" + std::to_string(h);
  auto it = gInstances.find(key);
  if (it != gInstances.end()) return it->second.get();
  LoadedPlugin *L = loadPlugin(bundle, idx, err);
  if (!L) return nullptr;
  auto inst = std::make_unique<Instance>();
  inst->w = w; inst->h = h;
  inst->fx = std::make_unique<Effect>();
  Effect *e = inst->fx.get();
  Effect *d = L->desc.get();
  e->props = d->props;
  e->props.setS(kOfxImageEffectPropContext, {L->context.c_str()});
  e->props.setI(kOfxPropIsInteractive, {0});
  e->props.setD(kOfxImageEffectPropProjectSize, {(double)w, (double)h});
  e->props.setD(kOfxImageEffectPropProjectExtent, {(double)w, (double)h});
  e->props.setD(kOfxImageEffectPropProjectOffset, {0.0, 0.0});
  e->props.setD(kOfxImageEffectPropProjectPixelAspectRatio, {1.0});
  e->props.setD(kOfxImageEffectInstancePropEffectDuration, {gDuration});
  e->props.setD(kOfxImageEffectPropFrameRate, {30.0});
  e->props.setI(kOfxImageEffectInstancePropSequentialRender, {0});
  e->props.setP(kOfxPropInstanceData, nullptr);
  // params (copy descriptors, initialise values)
  for (auto &pp : d->params.list) {
    auto np = std::make_unique<Param>(*pp);
    initParamValue(*np, w, h);
    e->params.list.push_back(std::move(np));
  }
  e->params.props = d->params.props;
  // clips
  const char *depthStr = L->depth == 8 ? kOfxBitDepthByte : L->depth == 16 ? kOfxBitDepthShort : kOfxBitDepthFloat;
  for (auto &cn : d->clipOrder) {
    auto c = std::make_unique<Clip>();
    c->name = cn;
    c->props = d->clips[cn]->props;
    bool connected = cn == kOfxImageEffectSimpleSourceClipName || cn == kOfxImageEffectOutputClipName;
    c->props.setS(kOfxImageEffectPropPixelDepth, {connected ? depthStr : kOfxBitDepthNone});
    c->props.setS(kOfxImageEffectPropComponents, {connected ? kOfxImageComponentRGBA : kOfxImageComponentNone});
    c->props.setS(kOfxImageClipPropUnmappedPixelDepth, {depthStr});
    c->props.setS(kOfxImageClipPropUnmappedComponents, {kOfxImageComponentRGBA});
    c->props.setS(kOfxImageEffectPropPreMultiplication, {kOfxImageUnPreMultiplied});
    c->props.setD(kOfxImagePropPixelAspectRatio, {1.0});
    c->props.setD(kOfxImageEffectPropFrameRate, {30.0});
    c->props.setD(kOfxImageEffectPropFrameRange, {0.0, gDuration});
    c->props.setS(kOfxImageClipPropFieldOrder, {kOfxImageFieldNone});
    c->props.setI(kOfxImageClipPropConnected, {connected ? 1 : 0});
    c->props.setD(kOfxImageEffectPropUnmappedFrameRange, {0.0, gDuration});
    c->props.setD(kOfxImageEffectPropUnmappedFrameRate, {30.0});
    c->props.setI(kOfxImageClipPropContinuousSamples, {0});
    e->clipOrder.push_back(cn);
    e->clips[cn] = std::move(c);
  }
  OfxStatus s = callAction(L->p, kOfxActionCreateInstance, e, nullptr, nullptr);
  if (s != kOfxStatOK && s != kOfxStatReplyDefault) { err = "create instance failed (" + std::to_string(s) + ")" + (gLastPluginMessage.empty() ? "" : ": " + gLastPluginMessage); return nullptr; }
  // clip preferences (we keep RGBA at the chosen depth; the action lets the plug-in initialise)
  PropSet outPrefs;
  callAction(L->p, kOfxImageEffectActionGetClipPreferences, e, nullptr, &outPrefs);
  setupImage(inst->src, w, h, L->depth, kOfxImageUnPreMultiplied);
  setupImage(inst->out, w, h, L->depth, kOfxImageUnPreMultiplied);
  Instance *raw = inst.get();
  gInstances[key] = std::move(inst);
  return raw;
}

static bool readFile(const std::string &p, std::vector<unsigned char> &out) {
  std::ifstream f(p, std::ios::binary); if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()); return true;
}
static bool writeFile(const std::string &p, const unsigned char *d, size_t n) {
  std::ofstream f(p, std::ios::binary); if (!f) return false; f.write(reinterpret_cast<const char *>(d), (std::streamsize)n); return (bool)f;
}

// top-down RGBA8 <-> bottom-up image at the plug-in's depth
static void toOfx(const std::vector<unsigned char> &in, Image &img, int w, int h, int depth) {
  size_t row = (size_t)w * 4;
  for (int y = 0; y < h; y++) {
    const unsigned char *s = in.data() + (size_t)(h - 1 - y) * row;
    if (depth == 8) std::memcpy(img.buf.data() + y * row, s, row);
    else if (depth == 16) { auto *d = reinterpret_cast<unsigned short *>(img.buf.data()) + y * row; for (size_t k = 0; k < row; k++) d[k] = (unsigned short)(s[k] * 257); }
    else { auto *d = reinterpret_cast<float *>(img.buf.data()) + y * row; for (size_t k = 0; k < row; k++) d[k] = s[k] / 255.0f; }
  }
}
static void fromOfx(const Image &img, std::vector<unsigned char> &out, int w, int h, int depth) {
  size_t row = (size_t)w * 4;
  out.resize(row * h);
  for (int y = 0; y < h; y++) {
    unsigned char *d = out.data() + (size_t)(h - 1 - y) * row;
    if (depth == 8) std::memcpy(d, img.buf.data() + y * row, row);
    else if (depth == 16) { auto *s = reinterpret_cast<const unsigned short *>(img.buf.data()) + y * row; for (size_t k = 0; k < row; k++) d[k] = (unsigned char)(s[k] / 257); }
    else { auto *s = reinterpret_cast<const float *>(img.buf.data()) + y * row; for (size_t k = 0; k < row; k++) { float v = s[k]; v = v < 0 ? 0 : v > 1 ? 1 : v; d[k] = (unsigned char)std::lround(v * 255.0f); } }
  }
}

static std::vector<std::string> split(const std::string &s, char c) {
  std::vector<std::string> out; std::string cur;
  for (char ch : s) { if (ch == c) { out.push_back(cur); cur.clear(); } else cur += ch; }
  out.push_back(cur); return out;
}

static void render(const std::vector<std::string> &a) {
  // RENDER bundle idx w h time in out params
  if (a.size() < 8) { std::cout << "ERR\tbad RENDER\n" << std::flush; return; }
  auto t0 = std::chrono::steady_clock::now();
  std::string bundle = a[1];
  int idx = std::atoi(a[2].c_str()), w = std::atoi(a[3].c_str()), h = std::atoi(a[4].c_str());
  double time = std::atof(a[5].c_str());
  if (w <= 0 || h <= 0 || w > 16384 || h > 16384) { std::cout << "ERR\tbad size\n" << std::flush; return; }
  std::string err;
  gLastPluginMessage.clear();
  Instance *inst = getInstance(bundle, idx, w, h, err);
  if (!inst) { std::cout << "ERR\t" << clean(err) << "\n" << std::flush; return; }
  LoadedPlugin *L = gPlugins[bundle + "|" + std::to_string(idx)].get();
  std::vector<unsigned char> in;
  if (!readFile(a[6], in) || in.size() < (size_t)w * h * 4) { std::cout << "ERR\tinput frame missing\n" << std::flush; return; }
  Effect *e = inst->fx.get();
  // params: name=v,v;name=v
  if (a.size() > 8 && !a[8].empty()) {
    for (auto &kv : split(a[8], ';')) {
      size_t eq = kv.find('='); if (eq == std::string::npos) continue;
      Param *p = e->params.find(kv.substr(0, eq));
      if (!p || !p->numeric()) continue;
      auto vals = split(kv.substr(eq + 1), ',');
      for (int k = 0; k < p->dims() && k < (int)vals.size(); k++) p->v[k] = std::atof(vals[k].c_str());
    }
  }
  gCurTime = time;
  toOfx(in, inst->src, w, h, L->depth);
  std::fill(inst->out.buf.begin(), inst->out.buf.end(), 0);
  for (auto &kv : e->clips) kv.second->frame = nullptr;
  if (e->clips.count(kOfxImageEffectSimpleSourceClipName)) e->clips[kOfxImageEffectSimpleSourceClipName]->frame = &inst->src;
  if (e->clips.count(kOfxImageEffectOutputClipName)) e->clips[kOfxImageEffectOutputClipName]->frame = &inst->out;

  PropSet args;
  args.setD(kOfxPropTime, {time});
  args.setS(kOfxImageEffectPropFieldToRender, {kOfxImageFieldNone});
  args.setI(kOfxImageEffectPropRenderWindow, {0, 0, w, h});
  args.setD(kOfxImageEffectPropRenderScale, {1.0, 1.0});
  args.setI(kOfxImageEffectPropSequentialRenderStatus, {0});
  args.setI(kOfxImageEffectPropInteractiveRenderStatus, {0});
  args.setI(kOfxImageEffectPropRenderQualityDraft, {0});
  // identity? (the plug-in may say "nothing to do" — output = source)
  PropSet idOut;
  idOut.setS(kOfxPropName, {""});
  idOut.setD(kOfxPropTime, {time});
  OfxStatus s = callAction(L->p, kOfxImageEffectActionIsIdentity, e, &args, &idOut);
  bool identity = s == kOfxStatOK && !idOut.str(kOfxPropName).empty();
  if (identity) {
    inst->out.buf = inst->src.buf;
    inst->out.props.setP(kOfxImagePropData, inst->out.buf.data());
  } else {
    PropSet seq;
    seq.setD(kOfxImageEffectPropFrameRange, {time, time});
    seq.setD(kOfxImageEffectPropFrameStep, {1.0});
    seq.setI(kOfxPropIsInteractive, {0});
    seq.setD(kOfxImageEffectPropRenderScale, {1.0, 1.0});
    seq.setI(kOfxImageEffectPropSequentialRenderStatus, {0});
    seq.setI(kOfxImageEffectPropInteractiveRenderStatus, {0});
    callAction(L->p, kOfxImageEffectActionBeginSequenceRender, e, &seq, nullptr);
    s = callAction(L->p, kOfxImageEffectActionRender, e, &args, nullptr);
    callAction(L->p, kOfxImageEffectActionEndSequenceRender, e, &seq, nullptr);
    if (s != kOfxStatOK && s != kOfxStatReplyDefault) {
      std::cout << "ERR\trender failed (" << s << ")" << (gLastPluginMessage.empty() ? "" : ": " + clean(gLastPluginMessage)) << "\n" << std::flush;
      return;
    }
  }
  std::vector<unsigned char> out;
  fromOfx(inst->out, out, w, h, L->depth);
  if (!writeFile(a[7], out.data(), out.size())) { std::cout << "ERR\tcannot write output\n" << std::flush; return; }
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  std::cout << "OK\t" << ms << (identity ? "\tidentity" : "") << "\n" << std::flush;
}

int main() {
  std::ios::sync_with_stdio(false);
  initHost();
  std::cout << "READY\tAnimeStudio OFX host 1.0\n" << std::flush;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto a = split(line, '\t');
    if (a.empty() || a[0].empty()) continue;
    if (a[0] == "QUIT") break;
    if (a[0] == "PING") { std::cout << "PONG\n" << std::flush; continue; }
    if (a[0] == "DESCRIBE" && a.size() >= 2) { describe(a[1]); continue; }
    if (a[0] == "RENDER") { render(a); continue; }
    if (a[0] == "DURATION" && a.size() >= 2) { gDuration = std::atof(a[1].c_str()); std::cout << "OK\n" << std::flush; continue; }
    std::cout << "ERR\tunknown command\n" << std::flush;
  }
  return 0;
}
