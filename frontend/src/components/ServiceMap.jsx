// ============================================================
// src/components/ServiceMap.jsx
// Interactive D3 force-directed topology graph.
// Nodes = microservices, edges = gRPC calls (width = RPS).
// Node colour = health score. Supports drag, zoom, and pan.
//
// Enhancements:
//  1. Animated traffic particles on edges
//  2. Critical path highlighting during simulation
//  3. Node badge (replica count)
//  4. Edge tooltip on hover
//  5. Node slide-over on click (ServiceDetailDrawer)
//  6. Right-click context menu
// ============================================================
import React, { useEffect, useRef, useCallback, useState } from 'react';
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

function particleColor(health) {
  if (health >= 80) return '#10b981';
  if (health >= 50) return '#f59e0b';
  return '#ef4444';
}

// ── ServiceMap ───────────────────────────────────────────────
export default function ServiceMap({
  topology, services, simulationResult,
  onServiceSelect, onNavigateSimulate,
}) {
  const svgRef       = useRef(null);
  const simRef       = useRef(null);
  const containerRef = useRef(null);
  const animRef      = useRef(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [contextMenu, setContextMenu]   = useState(null); // {x, y, service}
  const [edgeTooltip, setEdgeTooltip]   = useState(null); // {x, y, html}
  const [replicaMap, setReplicaMap]      = useState({});   // serviceId → {count, changedAt}

  const simServices  = simulationResult?.result || [];
  const criticalPath = simulationResult?.critical_path || [];
  const affectedSet  = new Set((simulationResult?.affected_services || simServices.map(s => s.name)));
  const isSimMode    = simServices.length > 0;

  // ── Track replica changes from CONTROL_ACTION via services prop ──
  useEffect(() => {
    const now = Date.now();
    setReplicaMap(prev => {
      const next = { ...prev };
      services.forEach(s => {
        const replicas = s.replicas ?? 1;
        const existing = prev[s.name];
        if (!existing || existing.count !== replicas) {
          next[s.name] = { count: replicas, changedAt: existing ? now : 0 };
        }
      });
      return next;
    });
  }, [services]);

  // ── Dismiss context menu on Escape or outside click ──
  useEffect(() => {
    const dismiss = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      setContextMenu(null);
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, []);

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
        replicas: svc.replicas ?? 1,
      };
    });

    const edgeRpsMax = Math.max(...topology.edges.map(e => e.rps), 1);
    const links = topology.edges.map(e => ({
      source: e.source,
      target: e.target,
      rps:    e.rps,
      latency: e.latency || 0,
      errorRate: e.errorRate || 0,
      width:  1 + (e.rps / edgeRpsMax) * 5,
    }));

    // Critical path set for highlighting
    const critPathSet = new Set(criticalPath.map(cp => `${cp.source}→${cp.target}`));

    // ── Clear previous render ──────────────────────────────
    d3.select(svgRef.current).selectAll('*').remove();
    if (simRef.current) { simRef.current.stop(); }
    if (animRef.current) { cancelAnimationFrame(animRef.current); }

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

    // Pulsing critical path marker
    if (isSimMode && criticalPath.length) {
      const defs = svg.select('defs');
      defs.append('marker')
        .attr('id', 'arrow-critical')
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', NODE_RADIUS + 14)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', '#ef4444');
    }

    // ── Links ─────────────────────────────────────────────
    const link = g.append('g').selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', d => {
        if (isSimMode && critPathSet.has(`${typeof d.source === 'object' ? d.source.id : d.source}→${typeof d.target === 'object' ? d.target.id : d.target}`)) {
          return '#ef4444';
        }
        return 'rgba(148,163,184,0.35)';
      })
      .attr('stroke-width', d => {
        if (isSimMode && critPathSet.has(`${typeof d.source === 'object' ? d.source.id : d.source}→${typeof d.target === 'object' ? d.target.id : d.target}`)) {
          return d.width + 2;
        }
        return d.width;
      })
      .attr('marker-end', d => {
        if (isSimMode && critPathSet.has(`${typeof d.source === 'object' ? d.source.id : d.source}→${typeof d.target === 'object' ? d.target.id : d.target}`)) {
          return 'url(#arrow-critical)';
        }
        return 'url(#arrow)';
      })
      .classed('critical-path-edge', d => isSimMode && critPathSet.has(`${typeof d.source === 'object' ? d.source.id : d.source}→${typeof d.target === 'object' ? d.target.id : d.target}`));

    // ── Edge tooltip zone (invisible wider hit area) ──────
    const edgeHitArea = g.append('g').selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'transparent')
      .attr('stroke-width', 16)
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => {
        const src = typeof d.source === 'object' ? d.source.id : d.source;
        const tgt = typeof d.target === 'object' ? d.target.id : d.target;
        setEdgeTooltip({
          x: event.offsetX + 12,
          y: event.offsetY - 10,
          html: `<b>${src} → ${tgt}</b><br/>${d.rps.toFixed(1)} rps · ${Math.round(d.latency)}ms avg · ${(d.errorRate).toFixed(2)}% errors`,
        });
      })
      .on('mousemove', (event) => {
        setEdgeTooltip(prev => prev ? { ...prev, x: event.offsetX + 12, y: event.offsetY - 10 } : null);
      })
      .on('mouseleave', () => setEdgeTooltip(null));

    // ── Traffic particles layer ───────────────────────────
    const particlesGroup = g.append('g').attr('class', 'traffic-particles');

    // ── Node groups ───────────────────────────────────────
    const node = g.append('g').selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')
      .style('opacity', d => {
        if (isSimMode && !affectedSet.has(d.id)) return 0.2;
        return 1;
      })
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

    // ── Replica badge (Feature 3) ─────────────────────────
    const now = Date.now();
    node.append('circle')
      .attr('cx', NODE_RADIUS - 6)
      .attr('cy', -(NODE_RADIUS - 6))
      .attr('r', 9)
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('stroke-width', 1.5)
      .attr('class', d => {
        const info = replicaMap[d.id];
        return (info && info.changedAt && (now - info.changedAt) < 30000) ? 'replica-badge pulse' : 'replica-badge';
      });

    node.append('text')
      .attr('x', NODE_RADIUS - 6)
      .attr('y', -(NODE_RADIUS - 6))
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 8)
      .attr('font-weight', 700)
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('fill', '#e2e8f0')
      .text(d => replicaMap[d.id]?.count ?? d.replicas);

    // ── Node tooltip on hover ─────────────────────────────
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
            <div>Replicas: <b>${replicaMap[d.id]?.count ?? d.replicas}</b></div>
            ${d.tag ? `<div>Scenario: <b style="color:${SIM_TAG_COLORS[d.tag]}">${d.tag}</b></div>` : ''}
          `);
      })
      .on('mouseleave', () => tooltip.style('display', 'none'))
      .on('click', (event, d) => {
        event.stopPropagation();
        const svc = services.find(s => s.name === d.id);
        if (svc) {
          setSelectedNode(svc);
          if (onServiceSelect) onServiceSelect(d.id);
        }
      })
      // ── Right-click context menu (Feature 6) ────────────
      .on('contextmenu', (event, d) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.offsetX, y: event.offsetY, service: d.id });
      });

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
        edgeHitArea
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });

    // ── Animated traffic particles (Feature 1) ────────────
    // Build particle state per edge
    const particleState = links.map(l => {
      const count = Math.min(5, Math.ceil(l.rps / 100));
      const speed = 0.002 + (l.rps / edgeRpsMax) * 0.008; // normalized speed
      const particles = [];
      for (let i = 0; i < count; i++) {
        particles.push({ t: i / count }); // evenly spaced along edge
      }
      return { link: l, particles, speed };
    });

    function animateParticles() {
      particlesGroup.selectAll('circle').remove();

      particleState.forEach(({ link: l, particles, speed }) => {
        const sx = l.source.x, sy = l.source.y;
        const tx = l.target.x, ty = l.target.y;
        if (sx == null || ty == null) return;

        // Determine color from source node health
        const sourceNode = nodes.find(n => n.id === (typeof l.source === 'object' ? l.source.id : l.source));
        const color = sourceNode ? particleColor(sourceNode.health) : '#10b981';

        particles.forEach(p => {
          p.t = (p.t + speed) % 1;
          const x = sx + (tx - sx) * p.t;
          const y = sy + (ty - sy) * p.t;

          particlesGroup.append('circle')
            .attr('cx', x)
            .attr('cy', y)
            .attr('r', 3)
            .attr('fill', color)
            .attr('opacity', 0.8);
        });
      });

      animRef.current = requestAnimationFrame(animateParticles);
    }

    // Start after simulation settles a bit
    setTimeout(() => { animRef.current = requestAnimationFrame(animateParticles); }, 800);

  }, [topology, services, simulationResult, replicaMap]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      simRef.current?.stop();
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  // ── Context menu handlers ─────────────────────────────────
  const handleCtxAction = (action) => {
    const svc = contextMenu?.service;
    setContextMenu(null);
    if (!svc) return;

    if (action === 'details') {
      const s = services.find(sv => sv.name === svc);
      if (s) { setSelectedNode(s); if (onServiceSelect) onServiceSelect(svc); }
    } else if (action === 'simulate') {
      if (onNavigateSimulate) onNavigateSimulate(svc);
    } else if (action === 'history') {
      const s = services.find(sv => sv.name === svc);
      if (s) setSelectedNode(s);
    }
  };

  return (
    <div ref={containerRef} className="service-map" style={{ position: 'relative' }}>
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />

      {/* Node tooltip overlay */}
      <div className="topo-tooltip" style={{ display: 'none', position: 'absolute', pointerEvents: 'none' }} />

      {/* Edge tooltip (Feature 4) */}
      {edgeTooltip && (
        <div
          className="edge-tooltip"
          style={{ left: edgeTooltip.x, top: edgeTooltip.y }}
          dangerouslySetInnerHTML={{ __html: edgeTooltip.html }}
        />
      )}

      {/* Legend */}
      <div className="topo-legend">
        {[['#10b981','Healthy (≥80)'], ['#eab308','Degraded (≥50)'], ['#ef4444','Critical (<50)']].map(([c, l]) => (
          <div key={l} className="legend-item">
            <span className="legend-dot" style={{ background: c }} />
            <span>{l}</span>
          </div>
        ))}
        {isSimMode && (
          <>
            <div className="legend-item"><span className="legend-dot" style={{ background: 'var(--blue)', borderRadius: 0 }} /><span>Simulation Active</span></div>
            <div className="legend-item legend-sim-note">⚠️ Showing impact overlay — greyed nodes are unaffected</div>
          </>
        )}
      </div>

      {/* Right-click context menu (Feature 6) */}
      {contextMenu && (
        <div
          className="node-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="ctx-menu-title">{contextMenu.service}</div>
          <button className="ctx-menu-item" onClick={() => handleCtxAction('details')}>🔍 View details</button>
          <button className="ctx-menu-item" onClick={() => handleCtxAction('simulate')}>🔬 Run simulation</button>
          <button className="ctx-menu-item" onClick={() => handleCtxAction('history')}>📈 View history</button>
        </div>
      )}

      {/* Node detail slide-over (Feature 5) */}
      {selectedNode && (
        <div className="service-detail-overlay" onClick={() => setSelectedNode(null)}>
          <div className="service-detail-drawer" onClick={e => e.stopPropagation()}>
            <div className="detail-header">
              <div className="detail-header-left">
                <span className="detail-name">{selectedNode.name}</span>
                <span className="detail-health-badge" style={{ background: healthToColor(selectedNode.health ?? 100) }}>
                  {Math.round(selectedNode.health ?? 100)}
                </span>
              </div>
              <button className="detail-close" onClick={() => setSelectedNode(null)}>✕</button>
            </div>
            <div className="detail-metrics">
              <div className="detail-metric">
                <span className="detail-metric-label">P99 Latency</span>
                <span className="detail-metric-value">{Math.round(selectedNode.latencyP99Ms ?? 0)}</span>
                <span className="detail-metric-unit">ms</span>
              </div>
              <div className="detail-metric">
                <span className="detail-metric-label">Throughput</span>
                <span className="detail-metric-value">{(selectedNode.throughputRps ?? 0).toFixed(1)}</span>
                <span className="detail-metric-unit">req/sec</span>
              </div>
              <div className="detail-metric">
                <span className="detail-metric-label">Error Rate</span>
                <span className="detail-metric-value">{(selectedNode.errorRatePct ?? 0).toFixed(2)}</span>
                <span className="detail-metric-unit">%</span>
              </div>
              <div className="detail-metric">
                <span className="detail-metric-label">Health</span>
                <span className="detail-metric-value" style={{ color: healthToColor(selectedNode.health ?? 100) }}>{Math.round(selectedNode.health ?? 100)}</span>
                <span className="detail-metric-unit">/ 100</span>
              </div>
              <div className="detail-metric">
                <span className="detail-metric-label">Replicas</span>
                <span className="detail-metric-value">{replicaMap[selectedNode.name]?.count ?? selectedNode.replicas ?? 1}</span>
                <span className="detail-metric-unit">pods</span>
              </div>
              <div className="detail-metric">
                <span className="detail-metric-label">Memory</span>
                <span className="detail-metric-value">{Math.round(selectedNode.memoryMib ?? 0)}</span>
                <span className="detail-metric-unit">MiB</span>
              </div>
            </div>

            {/* Mini sparkline placeholder */}
            {selectedNode.history && selectedNode.history.length > 0 && (
              <div className="detail-sparkline">
                <svg width="100%" height="40" viewBox="0 0 200 40" preserveAspectRatio="none">
                  <polyline
                    fill="none"
                    stroke="var(--blue)"
                    strokeWidth="2"
                    points={selectedNode.history.slice(-10).map((v, i) => {
                      const max = Math.max(...selectedNode.history.slice(-10));
                      const min = Math.min(...selectedNode.history.slice(-10));
                      const range = max - min || 1;
                      return `${(i / 9) * 200},${40 - ((v - min) / range) * 36}`;
                    }).join(' ')}
                  />
                </svg>
              </div>
            )}

            <button
              className="detail-sim-btn"
              onClick={() => {
                setSelectedNode(null);
                if (onNavigateSimulate) onNavigateSimulate(selectedNode.name);
              }}
            >
              🔬 Run simulation on this service
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
