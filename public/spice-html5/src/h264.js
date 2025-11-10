"use strict";
/*
   Copyright (C) 2025 - H.264 Support for spice-html5

   This file is part of spice-html5.

   spice-html5 is free software: you can redistribute it and/or modify
   it under the terms of the GNU Lesser General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   spice-html5 is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public License
   along with spice-html5.  If not, see <http://www.gnu.org/licenses/>.
*/

/*----------------------------------------------------------------------------
**  H.264 / MP4 Constants
**--------------------------------------------------------------------------*/
var H264Constants = {
    // H.264 codec strings for MediaSource API
    // Baseline Profile Level 3.0 (most compatible)
    SPICE_H264_CODEC_BASELINE   : 'video/mp4; codecs="avc1.42E01E"',

    // Main Profile Level 3.1 (better quality)
    SPICE_H264_CODEC_MAIN       : 'video/mp4; codecs="avc1.4D401F"',

    // High Profile Level 4.0 (best quality, modern browsers)
    SPICE_H264_CODEC_HIGH       : 'video/mp4; codecs="avc1.640028"',

    // Default codec (Baseline for compatibility)
    SPICE_H264_CODEC            : 'video/mp4; codecs="avc1.42E01E"',

    MAX_CLUSTER_TIME            : 1000,  // Max time between keyframes (ms)
};

/*----------------------------------------------------------------------------
**  H.264 Utility Functions
**--------------------------------------------------------------------------*/

/**
 * Check if the browser supports H.264 decoding via MediaSource
 * @returns {boolean} True if H.264 is supported
 */
function h264_supported()
{
    if (!window.MediaSource)
        return false;

    // Try different H.264 profiles, from most compatible to least
    var codecs = [
        H264Constants.SPICE_H264_CODEC_BASELINE,
        H264Constants.SPICE_H264_CODEC_MAIN,
        H264Constants.SPICE_H264_CODEC_HIGH
    ];

    for (var i = 0; i < codecs.length; i++)
    {
        if (MediaSource.isTypeSupported(codecs[i]))
        {
            H264Constants.SPICE_H264_CODEC = codecs[i];
            return true;
        }
    }

    return false;
}

/**
 * Get the best supported H.264 codec string
 * @returns {string} The codec MIME type string
 */
function get_h264_codec()
{
    if (!h264_supported())
        return null;

    return H264Constants.SPICE_H264_CODEC;
}

/**
 * Check if data appears to be H.264 NAL units
 * @param {Uint8Array} data - The data to check
 * @returns {boolean} True if data looks like H.264
 */
function is_h264_data(data)
{
    if (!data || data.length < 4)
        return false;

    // Check for H.264 NAL unit start codes
    // 0x00 0x00 0x00 0x01 (4-byte start code)
    if (data[0] === 0x00 && data[1] === 0x00 &&
        data[2] === 0x00 && data[3] === 0x01)
        return true;

    // 0x00 0x00 0x01 (3-byte start code)
    if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01)
        return true;

    // Check for fMP4 (ISO BMFF) box signature
    // Common boxes: ftyp, moov, moof, mdat
    if (data.length >= 8)
    {
        var boxType = String.fromCharCode(data[4], data[5], data[6], data[7]);
        if (boxType === 'ftyp' || boxType === 'moov' ||
            boxType === 'moof' || boxType === 'mdat')
            return true;
    }

    return false;
}

/**
 * Log H.264 stream information for debugging
 * @param {string} message - Debug message
 * @param {Object} data - Optional data to log
 */
function h264_log(message, data)
{
    if (window.console && console.log)
    {
        if (data !== undefined)
            console.log("[H.264] " + message, data);
        else
            console.log("[H.264] " + message);
    }
}

/*----------------------------------------------------------------------------
**  Module exports
**--------------------------------------------------------------------------*/
if (typeof module !== 'undefined' && module.exports)
{
    module.exports = {
        Constants: H264Constants,
        h264_supported: h264_supported,
        get_h264_codec: get_h264_codec,
        is_h264_data: is_h264_data,
        h264_log: h264_log,
    };
}
