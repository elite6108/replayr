//! GPU blend of straight-BGRA stills (PNG / text / overlay / HUD).
//! VideoProcessor ignores per-pixel alpha; this Draw path does not.

#![cfg(windows)]

use windows::core::{s, BOOL};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11BlendState, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11InputLayout,
    ID3D11PixelShader, ID3D11RasterizerState, ID3D11RenderTargetView, ID3D11SamplerState,
    ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER,
    D3D11_BIND_VERTEX_BUFFER, D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE,
    D3D11_BLEND_OP_ADD, D3D11_BLEND_SRC_ALPHA, D3D11_BUFFER_DESC, D3D11_COLOR_WRITE_ENABLE_ALL,
    D3D11_COMPARISON_NEVER, D3D11_CULL_NONE, D3D11_FILL_SOLID, D3D11_FILTER_MIN_MAG_MIP_LINEAR,
    D3D11_INPUT_ELEMENT_DESC, D3D11_INPUT_PER_VERTEX_DATA, D3D11_RASTERIZER_DESC,
    D3D11_RENDER_TARGET_BLEND_DESC, D3D11_RENDER_TARGET_VIEW_DESC, D3D11_RTV_DIMENSION_TEXTURE2D,
    D3D11_SAMPLER_DESC, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_DYNAMIC, D3D11_CPU_ACCESS_WRITE, D3D11_MAP_WRITE_DISCARD, D3D11_MAPPED_SUBRESOURCE,
    D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R32G32_FLOAT};

use super::transforms::PixelRect;

const HLSL: &[u8] = br#"
struct VSIn { float2 pos : POSITION; float2 uv : TEXCOORD; };
struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD; };
cbuffer Opacity : register(b0) { float opacity; float3 pad; };
Texture2D tex : register(t0);
SamplerState samp : register(s0);
VSOut vs_main(VSIn i) {
    VSOut o;
    o.pos = float4(i.pos, 0.0, 1.0);
    o.uv = i.uv;
    return o;
}
float4 ps_main(VSOut i) : SV_Target {
    float4 c = tex.Sample(samp, i.uv);
    c.a *= opacity;
    return c;
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    x: f32,
    y: f32,
    u: f32,
    v: f32,
}

pub struct StillBlender {
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    layout: ID3D11InputLayout,
    blend: ID3D11BlendState,
    raster: ID3D11RasterizerState,
    sampler: ID3D11SamplerState,
    vb: ID3D11Buffer,
    cb: ID3D11Buffer,
}

impl StillBlender {
    pub fn open(device: &ID3D11Device) -> Result<Self, String> {
        unsafe {
            let mut vs_blob = None;
            let mut vs_err = None;
            D3DCompile(
                HLSL.as_ptr() as *const _,
                HLSL.len(),
                None,
                None,
                None,
                s!("vs_main"),
                s!("vs_5_0"),
                D3DCOMPILE_OPTIMIZATION_LEVEL3,
                0,
                &mut vs_blob,
                Some(&mut vs_err),
            )
            .map_err(|err| format!("Could not compile still vertex shader: {err}"))?;
            let vs_blob = vs_blob.ok_or_else(|| "Still vertex shader was empty.".to_string())?;
            let vs_slice = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let mut vs = None;
            device
                .CreateVertexShader(vs_slice, None, Some(&mut vs))
                .map_err(|err| format!("Could not create still vertex shader: {err}"))?;

            let mut ps_blob = None;
            D3DCompile(
                HLSL.as_ptr() as *const _,
                HLSL.len(),
                None,
                None,
                None,
                s!("ps_main"),
                s!("ps_5_0"),
                D3DCOMPILE_OPTIMIZATION_LEVEL3,
                0,
                &mut ps_blob,
                None,
            )
            .map_err(|err| format!("Could not compile still pixel shader: {err}"))?;
            let ps_blob = ps_blob.ok_or_else(|| "Still pixel shader was empty.".to_string())?;
            let ps_slice = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut ps = None;
            device
                .CreatePixelShader(ps_slice, None, Some(&mut ps))
                .map_err(|err| format!("Could not create still pixel shader: {err}"))?;

            let elems = [
                D3D11_INPUT_ELEMENT_DESC {
                    SemanticName: s!("POSITION"),
                    SemanticIndex: 0,
                    Format: DXGI_FORMAT_R32G32_FLOAT,
                    InputSlot: 0,
                    AlignedByteOffset: 0,
                    InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
                    InstanceDataStepRate: 0,
                },
                D3D11_INPUT_ELEMENT_DESC {
                    SemanticName: s!("TEXCOORD"),
                    SemanticIndex: 0,
                    Format: DXGI_FORMAT_R32G32_FLOAT,
                    InputSlot: 0,
                    AlignedByteOffset: 8,
                    InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
                    InstanceDataStepRate: 0,
                },
            ];
            let mut layout = None;
            device
                .CreateInputLayout(&elems, vs_slice, Some(&mut layout))
                .map_err(|err| format!("Could not create still input layout: {err}"))?;

            let mut blend_desc = D3D11_BLEND_DESC::default();
            blend_desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
                BlendEnable: BOOL(1),
                SrcBlend: D3D11_BLEND_SRC_ALPHA,
                DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
                BlendOp: D3D11_BLEND_OP_ADD,
                SrcBlendAlpha: D3D11_BLEND_ONE,
                DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
                BlendOpAlpha: D3D11_BLEND_OP_ADD,
                RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
            };
            let mut blend = None;
            device
                .CreateBlendState(&blend_desc, Some(&mut blend))
                .map_err(|err| format!("Could not create still blend state: {err}"))?;

            let rast_desc = D3D11_RASTERIZER_DESC {
                FillMode: D3D11_FILL_SOLID,
                CullMode: D3D11_CULL_NONE,
                DepthClipEnable: BOOL(1),
                ..Default::default()
            };
            let mut raster = None;
            device
                .CreateRasterizerState(&rast_desc, Some(&mut raster))
                .map_err(|err| format!("Could not create still rasterizer: {err}"))?;

            let samp_desc = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                ComparisonFunc: D3D11_COMPARISON_NEVER,
                MaxLOD: f32::MAX,
                ..Default::default()
            };
            let mut sampler = None;
            device
                .CreateSamplerState(&samp_desc, Some(&mut sampler))
                .map_err(|err| format!("Could not create still sampler: {err}"))?;

            let vb_desc = D3D11_BUFFER_DESC {
                ByteWidth: (std::mem::size_of::<Vertex>() * 4) as u32,
                Usage: D3D11_USAGE_DYNAMIC,
                BindFlags: D3D11_BIND_VERTEX_BUFFER.0 as u32,
                CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                ..Default::default()
            };
            let mut vb = None;
            device
                .CreateBuffer(&vb_desc, None, Some(&mut vb))
                .map_err(|err| format!("Could not create still vertex buffer: {err}"))?;

            let cb_desc = D3D11_BUFFER_DESC {
                ByteWidth: 16,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            let mut cb = None;
            device
                .CreateBuffer(&cb_desc, None, Some(&mut cb))
                .map_err(|err| format!("Could not create still constant buffer: {err}"))?;

            Ok(Self {
                vs: vs.ok_or_else(|| "Still vertex shader was empty.".to_string())?,
                ps: ps.ok_or_else(|| "Still pixel shader was empty.".to_string())?,
                layout: layout.ok_or_else(|| "Still input layout was empty.".to_string())?,
                blend: blend.ok_or_else(|| "Still blend state was empty.".to_string())?,
                raster: raster.ok_or_else(|| "Still rasterizer was empty.".to_string())?,
                sampler: sampler.ok_or_else(|| "Still sampler was empty.".to_string())?,
                vb: vb.ok_or_else(|| "Still vertex buffer was empty.".to_string())?,
                cb: cb.ok_or_else(|| "Still constant buffer was empty.".to_string())?,
            })
        }
    }

    pub fn draw(
        &self,
        context: &ID3D11DeviceContext,
        rtv: &ID3D11RenderTargetView,
        srv: &ID3D11ShaderResourceView,
        canvas_w: u32,
        canvas_h: u32,
        dest: PixelRect,
        src: Option<PixelRect>,
        tex_w: u32,
        tex_h: u32,
        opacity: f32,
    ) -> Result<(), String> {
        if dest.is_empty() || canvas_w < 2 || canvas_h < 2 || tex_w == 0 || tex_h == 0 {
            return Ok(());
        }
        let verts = quad(canvas_w, canvas_h, dest, src, tex_w, tex_h);
        let opacity = [opacity.clamp(0.0, 1.0), 0.0, 0.0, 0.0];
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context
                .Map(&self.vb, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                .map_err(|err| format!("Could not map still vertices: {err}"))?;
            std::ptr::copy_nonoverlapping(verts.as_ptr(), mapped.pData as *mut Vertex, 4);
            context.Unmap(&self.vb, 0);
            context.UpdateSubresource(&self.cb, 0, None, opacity.as_ptr() as *const _, 0, 0);

            let viewport = D3D11_VIEWPORT {
                Width: canvas_w as f32,
                Height: canvas_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
                ..Default::default()
            };
            context.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
            context.RSSetViewports(Some(&[viewport]));
            context.RSSetState(&self.raster);
            context.OMSetBlendState(&self.blend, None, 0xffff_ffff);
            context.IASetInputLayout(&self.layout);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
            let stride = std::mem::size_of::<Vertex>() as u32;
            let offset = 0u32;
            let vb = Some(self.vb.clone());
            context.IASetVertexBuffers(
                0,
                1,
                Some(&vb as *const _),
                Some(&stride as *const _),
                Some(&offset as *const _),
            );
            context.VSSetShader(&self.vs, None);
            context.PSSetShader(&self.ps, None);
            context.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
            context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            context.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
            context.Draw(4, 0);
            context.PSSetShaderResources(0, Some(&[None]));
            context.OMSetRenderTargets(None, None);
        }
        Ok(())
    }
}

pub fn create_rtv(device: &ID3D11Device, texture: &ID3D11Texture2D) -> Result<ID3D11RenderTargetView, String> {
    let desc = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        ..Default::default()
    };
    let mut rtv = None;
    unsafe {
        device
            .CreateRenderTargetView(texture, Some(&desc), Some(&mut rtv))
            .map_err(|err| format!("Could not create still render target: {err}"))?;
    }
    rtv.ok_or_else(|| "Still render target was empty.".to_string())
}

pub fn create_srv(device: &ID3D11Device, texture: &ID3D11Texture2D) -> Result<ID3D11ShaderResourceView, String> {
    let mut srv = None;
    unsafe {
        device
            .CreateShaderResourceView(texture, None, Some(&mut srv))
            .map_err(|err| format!("Could not create still shader view: {err}"))?;
    }
    srv.ok_or_else(|| "Still shader view was empty.".to_string())
}

fn quad(
    canvas_w: u32,
    canvas_h: u32,
    dest: PixelRect,
    src: Option<PixelRect>,
    tex_w: u32,
    tex_h: u32,
) -> [Vertex; 4] {
    let l = (dest.x as f32 / canvas_w as f32) * 2.0 - 1.0;
    let r = ((dest.x + dest.w as i32) as f32 / canvas_w as f32) * 2.0 - 1.0;
    let t = 1.0 - (dest.y as f32 / canvas_h as f32) * 2.0;
    let b = 1.0 - ((dest.y + dest.h as i32) as f32 / canvas_h as f32) * 2.0;
    let (u0, v0, u1, v1) = match src {
        Some(src) if tex_w > 0 && tex_h > 0 => {
            let u0 = src.x as f32 / tex_w as f32;
            let v0 = src.y as f32 / tex_h as f32;
            let u1 = (src.x + src.w as i32) as f32 / tex_w as f32;
            let v1 = (src.y + src.h as i32) as f32 / tex_h as f32;
            (u0, v0, u1, v1)
        }
        _ => (0.0, 0.0, 1.0, 1.0),
    };
    [
        Vertex { x: l, y: t, u: u0, v: v0 },
        Vertex { x: r, y: t, u: u1, v: v0 },
        Vertex { x: l, y: b, u: u0, v: v1 },
        Vertex { x: r, y: b, u: u1, v: v1 },
    ]
}
