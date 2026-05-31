// ============================================================
// src/components/ServiceMap.jsx
// Interactive D3 force-directed topology graph.
// Nodes = microservices, edges = gRPC calls (width = RPS).
// Node colour = health score. Supports drag, zoom, and pan.
// ============================================================
import React, { useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';

// ── Constants ────────────────────────────────────────────────
const NODE_RADIUS = 28;
const SIM_TAG_COLORS = {
  failed:         '#ef4444',
  cascading:      '#f97316',
  partitioned:    '#f97316',
  degraded:       '#eab308',
  memory_pressure:'#eab308',
  scaled:         '#3b82f6',
  impacted:       '#f97316',
  normal:         '#10b981',
};

function healthToColor(score) {
  if (score == null) return '#6366f1';
  if (score >= 80)   return '#10b981';
  if (score >= 50)   return '#eab308';
  return '#ef4444';
}

// ── ServiceMap ───────────────────────────────────────────────
export default function ServiceMap({ topology, services, simulationResult }) {
  const svgRef       = useRef(null);
  const simRef       = useRef(null);   // D3 simulation ref so we can stop it on remount
  const containerRef = useRef(null);

  const simServices = simulationResult?.result || [];
  const isSimMode   = simServices.length > 0;

  const draw = useCallback(() => {
    if (!svgRef.current || !topology?.nodes?.length) return;

    const container = containerRef.current;
    const W = container.clientWidth  || 700;
    const H = container.clientHeight || 420;

    // ── Prepare data ──────────────────────────────────────
    const nodeMap = {};
    services.forEach(s => { nodeMap[s.name] = s; });

    const nodes = topology.nodes.map(n => {
      const svc    = nodeMap[n.id] || {};
      const simSvc = simServices.find(s => s.name === n.id) || {};
      return {
        id:     n.id,
        health: isSimMode ? (simSvc.health ?? svc.health ?? 100) : (svc.health ?? 100),
        tag:    simSvc.scenarioTag,
        latency: isSimMode ? (simSvc.predictedLatencyMs ?? svc.latencyP99Ms ?? 0) : (svc.latencyP99Ms ?? 0),
        rps:    isSimMode ? (simSvc.projectedRps ?? svc.throughputRps ?? 0) : (svc.throughputRps ?? 0),
        error:  isSimMode ? (simSvc.predictedErrorPct ?? svc.errorRatePct ?? 0) : (svc.errorRatePct ?? 0),
      };
    });

    const edgeRpsMax = Math.max(...topology.edges.map(e => e.rps), 1);
    const links = topology.edges.map(e => ({
      source: e.source,
      target: e.target,
      rps:    e.rps,
      width:  1 + (e.rps / edgeRpsMax) * 5,
    }));

    // ── Clear previous render ──────────────────────────────
    d3.select(svgRef.current).selectAll('*').remove();
    if (simRef.current) { simRef.current.stop(); }

    const svg = d3.select(svgRef.current)
      .attr('width', W)
      .attr('height', H)
      .attr('viewBox', `0 0 ${W} ${H}`);

    // ── Zoom + pan ─────────────────────────────────────────
    const g = svg.append('g');
    svg.call(
      d3.zoom()
        .scaleExtent([0.3, 3])
        .on('zoom', ({ transform }) => g.attr('transform', transform))
    );

    // ── Arrow marker ───────────────────────────────────────
    svg.append('defs').append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', NODE_RADIUS + 14)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', 'rgba(148,163,184,0.6)');

    // ── Links ─────────────────────────────────────────────
    const link = g.append('g').selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'rgba(148,163,184,0.35)')
      .attr('stroke-width', d => d.width)
      .attr('marker-end', 'url(#arrow)');

    // ── Node groups ───────────────────────────────────────
    const node = g.append('g').selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')
      .call(
        d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simRef.current.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simRef.current.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      );

    // Outer glow ring (simMode scenario tag)
    node.append('circle')
      .attr('r', NODE_RADIUS + 5)
      .attr('fill', 'none')
      .attr('stroke', d => isSimMode && d.tag ? (SIM_TAG_COLORS[d.tag] || 'transparent') : 'transparent')
      .attr('stroke-width', 2.5)
      .attr('stroke-dasharray', '4 2')
      .attr('opacity', 0.8);

    // Background circle
    node.append('circle')
      .attr('r', NODE_RADIUS)
      .attr('fill', d => `${healthToColor(d.health)}22`)
      .attr('stroke', d => healthToColor(d.health))
      .attr('stroke-width', 2);

    // Service name label (abbreviated)
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 9)
      .attr('font-family', 'Inter, sans-serif')
      .attr('font-weight', 600)
      .attr('fill', '#e2e8f0')
      .attr('y', -6)
      .text(d => d.id.replace('service', 'svc').replace('-cart', '-c'));

    // Latency sub-label
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 8)
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('fill', d => healthToColor(d.health))
      .attr('y', 8)
      .text(d => `${Math.round(d.latency)}ms`);

    // ── Tooltip on hover ─────────────────────────────────
    const tooltip = d3.select(container).select('.topo-tooltip');

    node
      .on('mouseenter', (event, d) => {
        tooltip
          .style('display', 'block')
          .style('left', `${event.offsetX + 14}px`)
          .style('top',  `${event.offsetY - 10}px`)
          .html(`
            <div class="topo-tip-title">${d.id}</div>
            <div>Health: <b style="color:${healthToColor(d.health)}">${Math.round(d.health)}</b></div>
            <div>P99: <b>${Math.round(d.latency)} ms</b></div>
            <div>RPS: <b>${d.rps.toFixed(1)}</b></div>
            <div>Errors: <b>${d.error.toFixed(2)}%</b></div>
            ${d.tag ? `<div>Scenario: <b style="color:${SIM_TAG_COLORS[d.tag]}">${d.tag}</b></div>` : ''}
          `);
      })
      .on('mouseleave', () => tooltip.style('display', 'none'));

    // ── D3 Force simulation ────────────────────────────────
    simRef.current = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(110).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-350))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide(NODE_RADIUS + 15))
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });

  }, [topology, services, simulationResult]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => { ro.disconnect(); simRef.current?.stop(); };
  }, [draw]);

  return (
    <div ref={containerRef} className="service-map" style={{ position: 'relative' }}>
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      {/* Tooltip overlay */}
      <div className="topo-tooltip" style={{ display: 'none', position: 'absolute', pointerEvents: 'none' }} />
      {/* Legend */}
      <div className="topo-legend">
        {[['#10b981','Healthy (≥80)'], ['#eab308','Degraded (≥50)'], ['#ef4444','Critical (<50)']].map(([c, l]) => (
          <div key={l} className="legend-item">
            <span className="legend-dot" style={{ background: c }} />
            <span>{l}</span>
          </div>
        ))}
        {isSimMode && <div className="legend-item"><span className="legend-dot" style={{ background: 'var(--blue)', borderRadius: 0 }} />Simulation Active</div>}
      </div>
    </div>
  );
}
