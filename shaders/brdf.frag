// ============================================================================
//  BRDF from Scratch
//  Stefan Groenewoud — https://www.artstation.com/stefangroenewoud/blog
//
//  Companion code for the "Writing a BRDF from Scratch" series (Parts 1–4).
//  A physically based BRDF written term by term: Lambert -> Burley diffuse,
//  GGX specular with height-correlated Smith visibility, Schlick Fresnel,
//  a metallic workflow, and a cheap translucency approximation.
//
//  Runs as a single full-screen fragment shader (analytic sphere, no meshes,
//  no textures). Tested target: glslViewer. See README for a Shadertoy port.
//
//  License: MIT (see LICENSE)
// ============================================================================

#ifdef GL_ES
precision highp float;
#endif

uniform vec2  u_resolution;
uniform float u_time;

// ----------------------------------------------------------------------------
//  STEP selects which part of the series to render
//    1 = Lambertian diffuse + hemisphere ambient       (Part 1)
//    2 = Burley diffuse + GGX specular                 (Part 2)
//    3 = Metallic workflow                             (Part 3)
//    4 = Cheap translucency                            (Part 4)
// ----------------------------------------------------------------------------
#ifndef STEP
#define STEP 4
#endif

#define PI 3.14159265359

// ----------------------------------------------------------------------------
//  Parameters
// ----------------------------------------------------------------------------

// Material
const vec3  ALBEDO          = vec3(0.8, 0.25, 0.0);
const float P_ROUGHNESS     = 0.5;    // perceptual roughness [0..1]
const float F0_DIELECTRIC   = 0.04;   // ~4% reflectance for common dielectrics

#if STEP == 3
const float METALLIC        = 1.0;    // Part 3 shows a fully metallic surface
#else
const float METALLIC        = 0.0;
#endif

// Light (directional, orbits the sphere over time)
const vec3  LIGHT_COLOR     = vec3(1.0);
const float LIGHT_STRENGTH  = 3.0;
const float LIGHT_SPEED     = 0.5;

// Hemisphere ambient (fake skylight + ground bounce)
const float AMBIENT_INTENSITY = 0.75;
const vec3  AMBIENT_SKY       = vec3(0.5, 0.6, 1.0);
const vec3  AMBIENT_GROUND    = vec3(0.4, 0.3, 0.25);

// Translucency (Part 4)
const float TRANSLUCENCY_POWER  = 175.0;
const float TRANSLUCENCY_AMOUNT = 1.0;

// Output
const float GAMMA           = 2.2;
const vec3  BACKGROUND      = vec3(0.02);

// ----------------------------------------------------------------------------
//  Diffuse
// ----------------------------------------------------------------------------

// Lambertian diffuse (Part 1): constant response, energy-normalised by 1/PI.
vec3 Lambertian(float inNoL, vec3 inAlbedo, vec3 inLightColor, float inLightIntensity)
{
    return (inAlbedo / PI) * inLightColor * inLightIntensity * inNoL;
}

// Schlick Fresnel, scalar form, using the spherical-gaussian approximation
// of pow(1 - u, 5) from Karis 2013 (UE4).
float F_Schlick(float inU, float inF0, float inF90)
{
    float Fc = exp2((-5.55473 * inU - 6.98316) * inU);
    return inF0 + (inF90 - inF0) * Fc;
}

// Vector form, needed for coloured metal reflectance (Part 3).
vec3 F_Schlick(float inU, vec3 inF0, vec3 inF90)
{
    float Fc = exp2((-5.55473 * inU - 6.98316) * inU);
    return inF0 + (inF90 - inF0) * Fc;
}

// Disney / Burley diffuse (Part 2): roughness-dependent retro-reflection
// and grazing-angle falloff. Returns the BRDF value (already divided by PI).
float Burley(float inNoV, float inNoL, float inLoH, float inRoughness)
{
    float f90          = 0.5 + 2.0 * inRoughness * inLoH * inLoH;
    float lightScatter = F_Schlick(inNoL, 1.0, f90);
    float viewScatter  = F_Schlick(inNoV, 1.0, f90);
    return lightScatter * viewScatter * (1.0 / PI);
}

// ----------------------------------------------------------------------------
//  Specular (Part 2)
// ----------------------------------------------------------------------------

// GGX / Trowbridge-Reitz normal distribution function.
//   D(h) = a^2 / (PI * ((n.h)^2 * (a^2 - 1) + 1)^2)
float GGX(float inNoH, float inAlpha)
{
    float temp = inAlpha / max(1e-8, (inNoH * inNoH * (inAlpha * inAlpha - 1.0) + 1.0));
    return temp * temp / PI;
}

// Smith Lambda for GGX:  (-1 + sqrt(1 + a^2 * tan^2(theta))) / 2
float GFGL(float inNoX, float inAlpha)
{
    return -0.5 + 0.5 * sqrt(1.0 + inAlpha * inAlpha * (1.0 / (inNoX * inNoX) - 1.0));
}

// Height-correlated Smith visibility, V = G2 / (4 * n.l * n.v)
// (Heitz 2014). Closer to the Disney model than the separable form.
float HCV(float inNoL, float inNoV, float inAlpha)
{
    inNoL = max(inNoL, 1e-3);
    inNoV = max(inNoV, 1e-3);
    float geo           = 1.0 / (1.0 + GFGL(inNoV, inAlpha) + GFGL(inNoL, inAlpha));
    float normalization = 1.0 / (4.0 * inNoL * inNoV);
    return geo * normalization;
}

// Reference: the same visibility term in the optimised form used by
// Frostbite / Filament. Not used, kept for comparison.
float V_SmithGGX(float inNoV, float inNoL, float inAlpha)
{
    float a2   = inAlpha * inAlpha;
    float GGXL = inNoV * sqrt((-inNoL * a2 + inNoL) * inNoL + a2);
    float GGXV = inNoL * sqrt((-inNoV * a2 + inNoV) * inNoV + a2);
    return 0.5 / (GGXV + GGXL);
}

// ----------------------------------------------------------------------------
//  Scene: analytic unit sphere seen from +Z
// ----------------------------------------------------------------------------

// Returns ray distance to the sphere, or -1.0 on a miss.
float intersectSphere(vec3 inRayOrigin, vec3 inRayDir, float inRadius)
{
    float b = dot(inRayOrigin, inRayDir);
    float c = dot(inRayOrigin, inRayOrigin) - inRadius * inRadius;
    float h = b * b - c;
    if (h < 0.0) return -1.0;
    return -b - sqrt(h);
}

void main()
{
    // --- Camera ray --------------------------------------------------------
    vec2 uv     = (2.0 * gl_FragCoord.xy - u_resolution.xy) / u_resolution.y;
    vec3 camPos = vec3(0.0, 0.0, 3.0);
    vec3 rayDir = normalize(vec3(uv, -2.0));

    float hit = intersectSphere(camPos, rayDir, 1.0);
    if (hit < 0.0)
    {
        gl_FragColor = vec4(pow(BACKGROUND, vec3(1.0 / GAMMA)), 1.0);
        return;
    }

    // These match the varyings used in the blog posts.
    vec3 fWorldPos    = camPos + rayDir * hit;
    vec3 fWorldNormal = normalize(fWorldPos);

    // --- Vectors -----------------------------------------------------------
    float t = u_time * LIGHT_SPEED;
    vec3 n  = fWorldNormal;
    vec3 e  = normalize(camPos - fWorldPos);              // eye / view vector
    vec3 l  = normalize(vec3(sin(t), 0.4, cos(t)));        // light vector
    vec3 h  = normalize(l + e);                            // half vector

    float NoL = max(dot(n, l), 0.0);
    float NoE = max(dot(n, e), 0.0);
    float NoH = max(dot(n, h), 0.0);
    float LoH = max(dot(l, h), 0.0);

    // --- Hemisphere ambient (Part 1) ---------------------------------------
    vec3 ambient = mix(AMBIENT_GROUND, AMBIENT_SKY, fWorldNormal.y * 0.5 + 0.5) * AMBIENT_INTENSITY;

    vec3 out_color;

#if STEP == 1
    // ------------------------------------------------------------------------
    //  Part 1 — Lambertian + hemisphere ambient
    // ------------------------------------------------------------------------
    out_color  = Lambertian(NoL, ALBEDO, LIGHT_COLOR, LIGHT_STRENGTH);
    // Ambient is indirect light: mask it out where direct light already lands,
    // so the two terms don't stack and overexpose the lit side.
    out_color += (1.0 - NoL) * ALBEDO * ambient;

#else
    // ------------------------------------------------------------------------
    //  Parts 2–4 — Burley diffuse + GGX specular (+ metallic, translucency)
    // ------------------------------------------------------------------------
    float alpha = P_ROUGHNESS * P_ROUGHNESS;              // perceptual -> alpha

    // Metallic workflow (Part 3): metals have no diffuse, and their specular
    // reflectance is tinted by the base colour.
    vec3 diffuseColor = ALBEDO * (1.0 - METALLIC);
    vec3 f0           = mix(vec3(F0_DIELECTRIC), ALBEDO, METALLIC);

    // Specular: D * V * F
    float D = GGX(NoH, alpha);
    float V = HCV(NoL, NoE, alpha);
    vec3  F = F_Schlick(LoH, f0, vec3(1.0));

    vec3 specular_light = D * V * F * LIGHT_COLOR * LIGHT_STRENGTH * NoL;

    // Diffuse: Burley. Note: no (1 - F) energy split between diffuse and
    // specular here, matching the series; a possible next refinement.
    vec3 diffuse = diffuseColor * Burley(NoE, NoL, LoH, alpha) * LIGHT_COLOR * LIGHT_STRENGTH * NoL;

  #if STEP >= 4
    // ------------------------------------------------------------------------
    //  Part 4 — Cheap translucency (not full SSS)
    //  Bend the light vector slightly toward the normal and look for light
    //  coming from behind the surface; a power controls the spread, and a
    //  distance mask keeps it near the light-facing core of the object.
    // ------------------------------------------------------------------------
    vec3  LTlight = l + n * 0.003;
    float LTDot   = pow(clamp(dot(e, -LTlight), 0.0, 1.0), TRANSLUCENCY_POWER);
    float tMask   = clamp(0.4 * length(fWorldPos - vec3(0.0, 0.3, 0.0)), 0.0, 1.0);
    vec3  translucent_light = LIGHT_COLOR * (vec3(LTDot) + ambient) * tMask * LIGHT_STRENGTH;

    // Lift saturation of the albedo with a curve so the rim reads warmer,
    // then blend the transmitted light into the diffuse response.
    vec3 albedoCurve = pow(diffuseColor, vec3(1.5));
    diffuse = mix(diffuse, diffuse + albedoCurve * translucent_light, TRANSLUCENCY_AMOUNT);
  #endif

    out_color  = diffuse;
    out_color += specular_light;

    // Diffuse ambient, masked by the direct term as in Part 1.
    out_color += (1.0 - NoL) * diffuseColor * ambient;

    // Specular ambient — APPROXIMATION.
    // The correct term needs a prefiltered environment map and a BRDF LUT
    // (split-sum IBL). This single-file setup has no textures, so it uses the
    // hemisphere colour along the reflection vector with view-dependent
    // Fresnel instead. This is the limitation described in Part 3.
    vec3 r          = reflect(-e, n);
    vec3 envColor   = mix(AMBIENT_GROUND, AMBIENT_SKY, r.y * 0.5 + 0.5) * AMBIENT_INTENSITY;
    vec3 F_ambient  = F_Schlick(NoE, f0, vec3(1.0));
    out_color      += F_ambient * envColor * (1.0 - alpha);
#endif

    // --- Output ------------------------------------------------------------
    gl_FragColor = vec4(pow(max(out_color, vec3(0.0)), vec3(1.0 / GAMMA)), 1.0);
}
