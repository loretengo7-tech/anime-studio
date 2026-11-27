// Minimal OpenFX filter used to smoke-test the AnimeStudio OFX host in CI.
// "AS Test Vignette": gain, invert, tint colour, a choice and a normalised 2D centre.
// Written against the raw C API (no support library) so it exercises the host's suites.
#include <cmath>
#include <cstring>
#include "ofxCore.h"
#include "ofxImageEffect.h"
#include "ofxMultiThread.h"
#include "ofxOld.h"
#include "ofxParam.h"
#include "ofxProperty.h"

#if defined(_WIN32)
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C" __attribute__((visibility("default")))
#endif

static OfxHost *gHost = nullptr;
static OfxPropertySuiteV1 *P = nullptr;
static OfxImageEffectSuiteV1 *E = nullptr;
static OfxParameterSuiteV1 *PS = nullptr;
static OfxMultiThreadSuiteV1 *MT = nullptr;

static OfxStatus onLoad() {
  P = (OfxPropertySuiteV1 *)gHost->fetchSuite(gHost->host, kOfxPropertySuite, 1);
  E = (OfxImageEffectSuiteV1 *)gHost->fetchSuite(gHost->host, kOfxImageEffectSuite, 1);
  PS = (OfxParameterSuiteV1 *)gHost->fetchSuite(gHost->host, kOfxParameterSuite, 1);
  MT = (OfxMultiThreadSuiteV1 *)gHost->fetchSuite(gHost->host, kOfxMultiThreadSuite, 1);
  return P && E && PS ? kOfxStatOK : kOfxStatErrMissingHostFeature;
}

static OfxStatus describe(OfxImageEffectHandle fx) {
  OfxPropertySetHandle props;
  E->getPropertySet(fx, &props);
  P->propSetString(props, kOfxPropLabel, 0, "AS Test Vignette");
  P->propSetString(props, kOfxImageEffectPluginPropGrouping, 0, "AnimeStudio");
  P->propSetString(props, kOfxImageEffectPropSupportedContexts, 0, kOfxImageEffectContextFilter);
  P->propSetString(props, kOfxImageEffectPropSupportedPixelDepths, 0, kOfxBitDepthFloat);
  P->propSetString(props, kOfxImageEffectPropSupportedPixelDepths, 1, kOfxBitDepthByte);
  return kOfxStatOK;
}

static OfxStatus describeInContext(OfxImageEffectHandle fx) {
  OfxPropertySetHandle cp;
  E->clipDefine(fx, kOfxImageEffectSimpleSourceClipName, &cp);
  P->propSetString(cp, kOfxImageEffectPropSupportedComponents, 0, kOfxImageComponentRGBA);
  E->clipDefine(fx, kOfxImageEffectOutputClipName, &cp);
  P->propSetString(cp, kOfxImageEffectPropSupportedComponents, 0, kOfxImageComponentRGBA);
  OfxParamSetHandle ps;
  E->getParamSet(fx, &ps);
  OfxPropertySetHandle pp;
  PS->paramDefine(ps, kOfxParamTypeDouble, "gain", &pp);
  P->propSetString(pp, kOfxPropLabel, 0, "Gain");
  P->propSetDouble(pp, kOfxParamPropDefault, 0, 1.0);
  P->propSetDouble(pp, kOfxParamPropDisplayMin, 0, 0.0);
  P->propSetDouble(pp, kOfxParamPropDisplayMax, 0, 4.0);
  PS->paramDefine(ps, kOfxParamTypeBoolean, "invert", &pp);
  P->propSetString(pp, kOfxPropLabel, 0, "Invert");
  P->propSetInt(pp, kOfxParamPropDefault, 0, 0);
  PS->paramDefine(ps, kOfxParamTypeRGB, "tint", &pp);
  P->propSetString(pp, kOfxPropLabel, 0, "Tint");
  P->propSetDouble(pp, kOfxParamPropDefault, 0, 1.0);
  P->propSetDouble(pp, kOfxParamPropDefault, 1, 1.0);
  P->propSetDouble(pp, kOfxParamPropDefault, 2, 1.0);
  PS->paramDefine(ps, kOfxParamTypeChoice, "shape", &pp);
  P->propSetString(pp, kOfxPropLabel, 0, "Vignette");
  P->propSetString(pp, kOfxParamPropChoiceOption, 0, "None");
  P->propSetString(pp, kOfxParamPropChoiceOption, 1, "Round");
  P->propSetInt(pp, kOfxParamPropDefault, 0, 0);
  PS->paramDefine(ps, kOfxParamTypeDouble2D, "center", &pp);
  P->propSetString(pp, kOfxPropLabel, 0, "Center");
  P->propSetString(pp, kOfxParamPropDoubleType, 0, kOfxParamDoubleTypeXYAbsolute);
  P->propSetString(pp, kOfxParamPropDefaultCoordinateSystem, 0, kOfxParamCoordinatesNormalised);
  P->propSetDouble(pp, kOfxParamPropDefault, 0, 0.5);
  P->propSetDouble(pp, kOfxParamPropDefault, 1, 0.5);
  return kOfxStatOK;
}

struct Job { void *src, *dst; int w, h, rowS, rowD; bool flt; double gain, tint[3], cx, cy; int inv, shape; };
static void rows(unsigned int ti, unsigned int n, void *arg) {
  Job *j = (Job *)arg;
  int y0 = j->h * ti / n, y1 = j->h * (ti + 1) / n;
  double rmax = std::sqrt((double)j->w * j->w + (double)j->h * j->h) * 0.5;
  for (int y = y0; y < y1; y++) for (int x = 0; x < j->w; x++) {
    double c[4];
    if (j->flt) { const float *s = (const float *)((const char *)j->src + (size_t)y * j->rowS) + x * 4; for (int k = 0; k < 4; k++) c[k] = s[k]; }
    else { const unsigned char *s = (const unsigned char *)j->src + (size_t)y * j->rowS + x * 4; for (int k = 0; k < 4; k++) c[k] = s[k] / 255.0; }
    double v = 1.0;
    if (j->shape == 1) { double d = std::hypot(x - j->cx, y - j->cy) / rmax; v = 1.0 - std::fmin(1.0, d * d); }
    for (int k = 0; k < 3; k++) { double o = c[k]; if (j->inv) o = 1.0 - o; o = o * j->gain * j->tint[k] * v; c[k] = o < 0 ? 0 : o > 1 ? 1 : o; }
    if (j->flt) { float *d = (float *)((char *)j->dst + (size_t)y * j->rowD) + x * 4; for (int k = 0; k < 4; k++) d[k] = (float)c[k]; }
    else { unsigned char *d = (unsigned char *)j->dst + (size_t)y * j->rowD + x * 4; for (int k = 0; k < 4; k++) d[k] = (unsigned char)std::lround(c[k] * 255.0); }
  }
}

static OfxStatus render(OfxImageEffectHandle fx, OfxPropertySetHandle inArgs) {
#ifdef AS_CRASH
  volatile int *bad = nullptr; *bad = 42; // deliberately crash: tests host crash isolation
#endif
  OfxTime t = 0;
  P->propGetDouble(inArgs, kOfxPropTime, 0, &t);
  OfxImageClipHandle srcC, dstC;
  E->clipGetHandle(fx, kOfxImageEffectSimpleSourceClipName, &srcC, nullptr);
  E->clipGetHandle(fx, kOfxImageEffectOutputClipName, &dstC, nullptr);
  OfxPropertySetHandle si, di;
  if (E->clipGetImage(srcC, t, nullptr, &si) != kOfxStatOK) return kOfxStatFailed;
  if (E->clipGetImage(dstC, t, nullptr, &di) != kOfxStatOK) { E->clipReleaseImage(si); return kOfxStatFailed; }
  Job j{};
  int b[4];
  P->propGetIntN(di, kOfxImagePropBounds, 4, b);
  j.w = b[2] - b[0]; j.h = b[3] - b[1];
  P->propGetPointer(si, kOfxImagePropData, 0, &j.src);
  P->propGetPointer(di, kOfxImagePropData, 0, &j.dst);
  P->propGetInt(si, kOfxImagePropRowBytes, 0, &j.rowS);
  P->propGetInt(di, kOfxImagePropRowBytes, 0, &j.rowD);
  char *depth = nullptr;
  P->propGetString(di, kOfxImageEffectPropPixelDepth, 0, &depth);
  j.flt = depth && std::strcmp(depth, kOfxBitDepthFloat) == 0;
  OfxParamSetHandle ps;
  E->getParamSet(fx, &ps);
  OfxParamHandle h;
  PS->paramGetHandle(ps, "gain", &h, nullptr); PS->paramGetValueAtTime(h, t, &j.gain);
  PS->paramGetHandle(ps, "invert", &h, nullptr); PS->paramGetValueAtTime(h, t, &j.inv);
  PS->paramGetHandle(ps, "tint", &h, nullptr); PS->paramGetValueAtTime(h, t, &j.tint[0], &j.tint[1], &j.tint[2]);
  PS->paramGetHandle(ps, "shape", &h, nullptr); PS->paramGetValueAtTime(h, t, &j.shape);
  PS->paramGetHandle(ps, "center", &h, nullptr); PS->paramGetValueAtTime(h, t, &j.cx, &j.cy);
  unsigned int n = 1;
  if (MT) MT->multiThreadNumCPUs(&n);
  if (MT && n > 1) MT->multiThread(rows, n > 8 ? 8 : n, &j); else rows(0, 1, &j);
  E->clipReleaseImage(si);
  E->clipReleaseImage(di);
  return kOfxStatOK;
}

static OfxStatus mainEntry(const char *action, const void *handle, OfxPropertySetHandle inArgs, OfxPropertySetHandle) {
  OfxImageEffectHandle fx = (OfxImageEffectHandle)handle;
  if (!std::strcmp(action, kOfxActionLoad)) return onLoad();
  if (!std::strcmp(action, kOfxActionDescribe)) return describe(fx);
  if (!std::strcmp(action, kOfxImageEffectActionDescribeInContext)) return describeInContext(fx);
  if (!std::strcmp(action, kOfxImageEffectActionRender)) return render(fx, inArgs);
  return kOfxStatReplyDefault;
}

static void setHost(OfxHost *h) { gHost = h; }
#ifdef AS_CRASH
static OfxPlugin plugin = {kOfxImageEffectPluginApi, 1, "com.animestudio.testcrash", 1, 0, setHost, mainEntry};
#else
static OfxPlugin plugin = {kOfxImageEffectPluginApi, 1, "com.animestudio.testvignette", 1, 0, setHost, mainEntry};
#endif
EXPORT int OfxGetNumberOfPlugins(void) { return 1; }
EXPORT OfxPlugin *OfxGetPlugin(int i) { return i == 0 ? &plugin : nullptr; }
