/** The original waveform density ramp, shared with feature-space density. */
export const DENSITY_COLOUR_GLSL = `
vec3 densityColour(float count){
 return vec3(count>.5?(count>.75?4.-4.*count:4.*count-2.):(count>.25?2.-4.*count:4.*count),count<.5?2.*count:2.-2.*count,count);
}`;
